/**
 * Government Trust List Validation Flow
 * 
 * Demonstrates verifier-side trust list validation using the government
 * services trust registry.
 * 
 * Prerequisites:
 *   --setup-gov-services must be run first
 * 
 * Steps:
 * 1. Clear wallet credentials
 * 2. Issue from TRUSTED issuer, wallet receives with trust list validation → PASS
 * 3. Verify trusted credential with trusted verifier + etsi-trust-list → PASS
 * 4. Issue from UNTRUSTED issuer, wallet receives WITHOUT trust validation → stored
 * 5. Verify untrusted credential with trusted verifier + etsi-trust-list → FAIL
 * 6. Verify untrusted credential with UNTRUSTED verifier (signature only) → PASS
 */

import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { RESOURCES, defaultWalletDidReference, defaultWalletKeyReference } from '../config.js';
import { PHOTO_ID_DOCTYPE, PHOTO_ID_NAMESPACE } from '../gov-services-config.js';
import { setupLogin } from '../commands/setup/index.js';
import {
  runWalletPresent,
  runAssertFinalStatus,
  runAssertFinalStatusFailed,
  clearWalletCredentials,
} from '../commands/run.js';

/** Extract stored wallet credential IDs from a receive response. */
function extractStoredCredentialIds(receiveResponse: unknown): string[] {
  if (
    typeof receiveResponse === 'object' &&
    receiveResponse !== null &&
    Array.isArray((receiveResponse as any).credentialIds)
  ) {
    return (receiveResponse as any).credentialIds.filter((id: unknown): id is string => typeof id === 'string');
  }

  if (!Array.isArray(receiveResponse)) {
    return [];
  }

  return receiveResponse.flatMap((result: any) =>
    Array.isArray(result?.stored)
      ? result.stored.map((stored: any) => stored?._id).filter((id: unknown): id is string => typeof id === 'string')
      : []
  );
}

/** Create credential offer from a specific issuer profile */
async function createOfferFromProfile(
  ctx: CommandContext,
  profilePath: string
): Promise<string> {
  const step = ctx.nextStep();
  const request = { authMethod: 'PRE_AUTHORIZED' };
  ctx.saveJson(`offer-${profilePath}-request.json`, request, step);

  const response = await ctx.orgClient.post(
    `/v2/${profilePath}/issuer-service-api/credentials/offers`,
    request
  );
  ctx.saveJson(`offer-${profilePath}-response.json`, response.data, step);

  const offerUrl = response.data.credentialOffer;
  if (!offerUrl) {
    throw new Error('Could not extract credentialOffer');
  }
  return offerUrl;
}

/** Wallet receives credential with issuance-time policies enabled */
async function walletReceiveWithTrust(
  ctx: CommandContext,
  offerUrl: string
): Promise<string[]> {
  const step = ctx.nextStep();

  const request = {
    offerUrl,
    keyId: ctx.ctx.walletKeyRef,
    did: ctx.ctx.walletDid,
    useClientAttestation: false,
  };
  ctx.saveJson('wallet-receive-trust-request.json', request, step);

  try {
    const response = await ctx.orgClient.post(
      `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/receive/pre-authorized`,
      request
    );
    ctx.saveJson('wallet-receive-trust-response.json', response.data, step);

    const credentialIds = extractStoredCredentialIds(response.data);
    console.log(`   [OK] Credential received (count: ${credentialIds.length})`);
    console.log(`        Credential IDs: ${credentialIds.join(', ')}`);
    return credentialIds;
  } catch (error: any) {
    console.log(`   [EXPECTED] Wallet rejected credential: ${error.message}`);
    return [];
  }
}

/** Wallet receives credential bypassing trust checks */
async function walletReceiveBypassTrust(
  ctx: CommandContext,
  offerUrl: string
): Promise<string[]> {
  const step = ctx.nextStep();

  const request = {
    offerUrl,
    keyId: ctx.ctx.walletKeyRef,
    did: ctx.ctx.walletDid,
    useClientAttestation: false,
  };
  ctx.saveJson('wallet-receive-no-trust-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/receive/pre-authorized`,
    request
  );
  ctx.saveJson('wallet-receive-no-trust-response.json', response.data, step);

  const credentialIds = extractStoredCredentialIds(response.data);
  console.log(`   [OK] Credential received (count: ${credentialIds.length})`);
  console.log(`        Credential IDs: ${credentialIds.join(', ')}`);
  return credentialIds;
}

/** Create verification session with ETSI trust list policy (trusted verifier) */
async function createTrustedVerifierSession(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create trusted verifier session with ETSI trust list policy', 'FLOW');

  const vcPolicies: any[] = [
    { policy: 'signature' },
    {
      policy: 'etsi-trust-list',
      expectedEntityType: 'PID_PROVIDER',
      allowStaleSource: true,
      requireAuthenticated: false,
    },
  ];

  const request = {
    flow_type: 'cross_device',
    core_flow: {
      dcql_query: {
        credentials: [
          {
            id: 'photo_id',
            format: 'mso_mdoc',
            meta: {
              doctype_value: PHOTO_ID_DOCTYPE,
            },
            claims: [
              { path: [PHOTO_ID_NAMESPACE, 'family_name'] },
              { path: [PHOTO_ID_NAMESPACE, 'given_name'] },
              { path: [PHOTO_ID_NAMESPACE, 'birth_date'] },
            ],
          },
        ],
      },
      policies: {
        vc_policies: vcPolicies,
      },
    },
  };
  ctx.saveJson('trusted-verifier-session-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
    request
  );
  ctx.saveJson('trusted-verifier-session-response.json', response.data, step);

  ctx.ctx.sessionId = response.data.sessionId;
  ctx.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;

  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) {
    throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
  }

  console.log(`   [OK] Trusted verifier session created (ID: ${ctx.ctx.sessionId})`);
  console.log(`        Policies: signature, etsi-trust-list`);
}

/** Create verification session with untrusted verifier (signature only, no trust registry) */
async function createUntrustedVerifierSession(
  ctx: CommandContext,
  untrustedTenantId: string,
  untrustedVerifierName: string,
  organization: string
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create untrusted verifier session (signature only)', 'FLOW');

  const verifierPath = `${organization}.${untrustedTenantId}.${untrustedVerifierName}`;

  const request = {
    flow_type: 'cross_device',
    core_flow: {
      dcql_query: {
        credentials: [
          {
            id: 'photo_id',
            format: 'mso_mdoc',
            meta: {
              doctype_value: PHOTO_ID_DOCTYPE,
            },
            claims: [
              { path: [PHOTO_ID_NAMESPACE, 'family_name'] },
              { path: [PHOTO_ID_NAMESPACE, 'given_name'] },
              { path: [PHOTO_ID_NAMESPACE, 'birth_date'] },
            ],
          },
        ],
      },
      policies: {
        vc_policies: [
          { policy: 'signature' },
        ],
      },
    },
  };
  ctx.saveJson('untrusted-verifier-session-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${verifierPath}/verifier2-service-api/verification-session/create`,
    request
  );
  ctx.saveJson('untrusted-verifier-session-response.json', response.data, step);

  ctx.ctx.sessionId = response.data.sessionId;
  ctx.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;

  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) {
    throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
  }

  console.log(`   [OK] Untrusted verifier session created (ID: ${ctx.ctx.sessionId})`);
  console.log(`        Verifier: ${verifierPath} (no trust registry)`);
  console.log(`        Policies: signature only`);
}

/**
 * Run the Government Trust List Validation flow.
 * 
 * Prerequisites:
 *   --setup-gov-services must be completed first
 * 
 * Required environment:
 *   Same vars as --setup-gov-services (cli/gov-services.env)
 *   GOV_UNTRUSTED_TENANT (default: untrusted-dept)
 */
export async function flowGovTrust(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  Flow: Government Trust List Validation');
  console.log('========================================\n');
  console.log(`Organization: ${ctx.config.organization}`);
  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Working directory: ${ctx.workdir}`);

  mkdirSync(ctx.workdir, { recursive: true });

  const organization = ctx.config.organization;
  const trustedProfilePath = `${organization}.${process.env.GOV_DEPT_IDENTITY || 'dept-identity'}.identity-issuer.photo-id`;
  const untrustedTenantId = process.env.GOV_UNTRUSTED_TENANT || 'untrusted-dept';
  const untrustedProfilePath = `${organization}.${untrustedTenantId}.untrusted-issuer.photo-id`;
  const untrustedVerifierPath = `${organization}.${untrustedTenantId}.untrusted-verifier`;

  try {
    await setupLogin(ctx);

    if (!ctx.ctx.walletKeyRef) {
      ctx.ctx.walletKeyRef = defaultWalletKeyReference(ctx.tenantPath);
    }
    if (!ctx.ctx.walletDid) {
      ctx.ctx.walletDid = defaultWalletDidReference(ctx.tenantPath);
    }

    // --- Step 1: Clear existing credentials ---
    console.log('\n--- Step 1: Clear wallet credentials ---');
    await clearWalletCredentials(ctx);

    // --- Step 2: Issue from TRUSTED issuer ---
    console.log('\n--- Step 2: Issue Photo ID from TRUSTED issuer (Identity) ---');
    const trustedOffer = await createOfferFromProfile(ctx, trustedProfilePath);
    console.log(`   [OK] Trusted credential offer created`);
    const trustedCredentialIds = await walletReceiveWithTrust(ctx, trustedOffer);
    if (trustedCredentialIds.length === 0) {
      throw new Error('Expected trusted credential to be received by wallet');
    }
    console.log('   [PASS] Trusted credential received by wallet');

    // --- Step 3: Verify trusted credential with trusted verifier + etsi-trust-list ---
    console.log('\n--- Step 3: Verify trusted credential with TRUSTED verifier (etsi-trust-list policy) ---');
    await createTrustedVerifierSession(ctx);
    await runWalletPresent(ctx, trustedCredentialIds);
    await runAssertFinalStatus(ctx);
    console.log('   [PASS] Trusted credential verified successfully with ETSI trust list');

    // Keep each same-doctype verification deterministic by storing only the
    // credential that should be presented in the next phase.
    await clearWalletCredentials(ctx);

    // --- Step 4: Issue from UNTRUSTED issuer bypassing trust ---
    console.log('\n--- Step 4: Issue Photo ID from UNTRUSTED issuer (stored for verifier negative case) ---');
    const untrustedOffer2 = await createOfferFromProfile(ctx, untrustedProfilePath);
    console.log(`   [OK] Untrusted credential offer created`);
    const untrustedCredentialIds = await walletReceiveBypassTrust(ctx, untrustedOffer2);
    if (untrustedCredentialIds.length === 0) {
      throw new Error('Expected untrusted credential to be stored by wallet');
    }
    console.log('   [OK] Untrusted credential stored');

    // --- Step 5: Verify untrusted credential with trusted verifier (should fail) ---
    console.log('\n--- Step 5: Verify untrusted credential with trusted verifier (should FAIL) ---');
    await createTrustedVerifierSession(ctx);
    await runWalletPresent(ctx, untrustedCredentialIds);
    let untrustedVerificationFailed = false;
    try {
      await runAssertFinalStatus(ctx);
    } catch (error: any) {
      untrustedVerificationFailed = true;
      console.log(`   [PASS] Untrusted credential correctly failed trust list verification: ${error.message}`);
      // Still check the final status is FAILED
      await runAssertFinalStatusFailed(ctx);
    }
    if (!untrustedVerificationFailed) {
      throw new Error('Untrusted credential unexpectedly passed trust list check');
    }

    // --- Step 6: Verify untrusted credential with UNTRUSTED verifier (signature only) ---
    console.log('\n--- Step 6: Verify with UNTRUSTED verifier (signature only, no trust registry) ---');
    await createUntrustedVerifierSession(ctx, untrustedTenantId, 'untrusted-verifier', organization);
    await runWalletPresent(ctx, untrustedCredentialIds);
    await runAssertFinalStatus(ctx, untrustedVerifierPath, 'untrusted-final-session-info.json');
    console.log('   [PASS] Credential verified with signature-only policy (no trust list check)');

    console.log('\n========================================');
    console.log('  Government Trust List Flow Complete');
    console.log('========================================\n');
    console.log('Demonstrated:');
    console.log('  ✓ Wallet receives trusted issuer credential');
    console.log('  ✓ Trusted verifier passes trusted credential');
    console.log('  ✓ Trusted verifier fails untrusted credential');
    console.log('  ✓ Untrusted verifier passes with signature-only (no trust list)');
  } finally {
    ctx.saveHttpLog();
    console.log(`\nLogs saved to: ${ctx.workdir}`);
  }
}
