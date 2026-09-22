/**
 * ETSI Trust Lists Flow
 *
 * Demonstrates trust list verification using the Enterprise Trust Registry Service.
 * This flow assumes the primary setup has been run (tenant, wallet, credentials exist).
 *
 * Unsigned Verifier2 services omit `clientId` so sessions bind as `redirect_uri`.
 * This flow additionally uses a signed Request Object and encrypted VP response:
 * Wallet2 authenticates the JAR by chaining the request-signing leaf to the IACA
 * pinned on Wallet2 (`requestObjectX509Trust`). The RP LoTE still lists that leaf
 * as a relying party; the IACA stays a PID/mDL issuer for `etsi-trust-list`.
 *
 * Steps:
 * 1. Clear existing credentials from wallet
 * 2. Issue a fresh credential for this flow
 * 3. Create a signed, encrypted verification session with ETSI trust list policy
 * 4. Present credential using the compact JAR URL and verify against trust registry
 */

import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { CERT_IDS, KEY_IDS, RESOURCES, MDL_DOC_TYPE, defaultWalletKeyReference } from '../config.js';
import { MDL_ISSUER_SERVICE_TYPE } from '../trust-registry/index.js';
import {
  getStoredCertificatePem,
  kmsKeyRef,
  setupLogin,
  x509HashClientId,
  certificatePemToDerBase64,
} from '../commands/setup/index.js';
import {
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runWalletPresent,
  runAssertFinalStatus,
  clearWalletCredentials,
} from '../commands/run.js';

/** Create a signed + encrypted verification session with ETSI Trust List policy */
async function createEtsiVerificationSession(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create signed verification session with ETSI Trust List policy', 'FLOW');

  const leafPem = await getStoredCertificatePem(ctx, CERT_IDS.verifierRequestSigningCert);
  const iacaPem = await getStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert);
  if (!leafPem) {
    throw new Error(
      'Verifier request-signing certificate not found. Run --setup-etsi-trust-registry first.'
    );
  }
  if (!iacaPem) {
    throw new Error('IACA certificate not found. Run --setup-etsi-trust-registry first.');
  }

  const vicalUrl = `${ctx.orgBaseUrl}/v1/${ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;
  const clientId = x509HashClientId(leafPem);
  const keyReference = kmsKeyRef(ctx, KEY_IDS.verifierRequestSigningKey);

  const vcPolicies = [
    { policy: 'signature' },
    {
      policy: 'vical',
      vicalUrl: vicalUrl,
      enableDocumentTypeValidation: true,
    },
    {
      policy: 'etsi-trust-list',
      expectedEntityType: 'PID_PROVIDER',
      expectedServiceType: MDL_ISSUER_SERVICE_TYPE,
      allowStaleSource: true,
      requireAuthenticated: false,
    },
  ];

  const request = {
    flow_type: 'cross_device',
    keyReference,
    core_flow: {
      dcql_query: {
        credentials: [
          {
            id: 'my_mdl',
            format: 'mso_mdoc',
            meta: {
              doctype_value: MDL_DOC_TYPE,
            },
            claims: [
              { path: ['org.iso.18013.5.1', 'family_name'] },
              { path: ['org.iso.18013.5.1', 'given_name'] },
              { path: ['org.iso.18013.5.1', 'birth_date'] },
            ],
          },
        ],
      },
      policies: {
        vc_policies: vcPolicies,
      },
      signed_request: true,
      encrypted_response: true,
      clientId,
      x5c: [
        certificatePemToDerBase64(leafPem),
        certificatePemToDerBase64(iacaPem),
      ],
    },
  };
  ctx.saveJson('create-etsi-verification-session-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier-service-api/verification-session/create`,
    request
  );
  ctx.saveJson('create-etsi-verification-session-response.json', response.data, step);

  ctx.ctx.sessionId = response.data.sessionId;
  ctx.ctx.requestUrl = response.data.fullAuthorizationRequestUrl;

  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) {
    throw new Error('Could not extract sessionId or fullAuthorizationRequestUrl');
  }

  console.log(`   [OK] Verification session created (ID: ${ctx.ctx.sessionId})`);
  console.log(`        Client ID: ${clientId}`);
  console.log(`        Policies: signature, vical, etsi-trust-list`);
  console.log(`        Request: signed JAR (x509_hash, leaf+IACA x5c), encrypted response`);
}

/**
 * Run the ETSI Trust Lists flow.
 *
 * Prerequisites:
 * - Primary setup must be completed
 * - ETSI trust registry must be set up (--setup-etsi-trust-registry)
 */
export async function flowEtsiTrustLists(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  Flow: ETSI Trust Lists');
  console.log('========================================\n');
  console.log(`Organization: ${ctx.config.organization}`);
  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Working directory: ${ctx.workdir}`);

  mkdirSync(ctx.workdir, { recursive: true });

  try {
    // Login first
    await setupLogin(ctx);

    // Set wallet key reference if not already set
    if (!ctx.ctx.walletKeyRef) {
      ctx.ctx.walletKeyRef = defaultWalletKeyReference(ctx.tenantPath);
    }

    // Step 1: Clear existing credentials
    console.log('\n--- Step 1: Clear Existing Credentials ---');
    await clearWalletCredentials(ctx);

    // Step 2: Issue a fresh credential for this flow
    console.log('\n--- Step 2: Issue Credential ---');
    await runCreateCredentialOffer(ctx, false);
    await runWalletReceiveCredential(ctx);

    // Step 3: Create signed verification session with etsi-trust-list policy
    console.log('\n--- Step 3: Create Signed Verification Session with ETSI Trust List Policy ---');
    await createEtsiVerificationSession(ctx);

    // Step 4: Wallet presents credential against the compact JAR
    console.log('\n--- Step 4: Present Credential ---');
    await runWalletPresent(ctx);

    // Step 5: Assert success
    console.log('\n--- Step 5: Verify Result ---');
    await runAssertFinalStatus(ctx);

    console.log('\n========================================');
    console.log('  SUCCESS - ETSI Trust Lists Flow Complete');
    console.log('========================================\n');
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}
