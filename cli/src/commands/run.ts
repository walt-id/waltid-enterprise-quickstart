/**
 * Run commands for executing use cases.
 * 
 * These commands handle the actual credential issuance and verification flows:
 * - Credential offer creation
 * - Wallet credential receipt
 * - Verification session creation
 * - Credential presentation
 * - Status assertions
 * - Credential revocation
 */

import { CommandContext } from '../context.js';
import { RESOURCES, STATUS_CONFIG_IDS, MDL_DOC_TYPE, defaultWalletDidReference } from '../config.js';

// ============================================================================
// Credential Issuance
// ============================================================================

/** Create credential offer */
export async function runCreateCredentialOffer(
  ctx: CommandContext,
  includeStatus: boolean = false
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Create credential offer${includeStatus ? ' (with status)' : ''}`, 'RUN');

  const request: any = {
    authMethod: 'PRE_AUTHORIZED',
  };
  
  if (includeStatus) {
    request.runtimeOverrides = {
      credentialStatus: {
        statusCredentialConfig: `${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}`,
        initialStatus: '0x0', // VALID
      },
    };
  }
  
  ctx.saveJson('create-offer-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}/issuer-service-api/credentials/offers`,
    request
  );
  ctx.saveJson('create-offer-response.json', response.data, step);

  ctx.ctx.offerId = response.data.credentialOffer;
  if (!ctx.ctx.offerId) {
    throw new Error('Could not extract credentialOffer');
  }
  
  // Extract session ID from offer URL for later status updates
  if (includeStatus && ctx.ctx.offerId) {
    try {
      const offerUrl = new URL(ctx.ctx.offerId);
      const credentialOfferUri = offerUrl.searchParams.get('credential_offer_uri');
      if (credentialOfferUri) {
        const offerUriUrl = new URL(credentialOfferUri);
        const sessionId = offerUriUrl.searchParams.get('id');
        if (sessionId) {
          ctx.ctx.issuerSessionIdWithStatus = `${ctx.tenantPath}.${RESOURCES.issuer}.${sessionId}`;
          console.log(`   [INFO] Issuer session ID for status updates: ${ctx.ctx.issuerSessionIdWithStatus}`);
        }
      }
    } catch (error) {
      console.log(`   [WARN] Could not extract session ID from offer URL`);
    }
  }
  
  console.log(`   [OK] Credential offer created${includeStatus ? ' with status tracking' : ''}`);
}

/** Wallet receive credential via pre-authorized flow */
export async function runWalletReceiveCredential(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Wallet receive credential via full pre-authorized flow', 'RUN');

  const request = {
    offerUrl: ctx.ctx.offerId,
    keyId: ctx.ctx.walletKeyRef,
    useClientAttestation: true,
  };
  ctx.saveJson('wallet-receive-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/receive/pre-authorized`,
    request
  );
  ctx.saveJson('wallet-receive-response.json', response.data, step);

  const receivedCount = Array.isArray(response.data) ? response.data.length : 0;
  const credentialIds = Array.isArray(response.data?.credentialIds) ? response.data.credentialIds : [];
  console.log(`   [OK] Credential received (count: ${credentialIds.length || receivedCount})`);
}

// ============================================================================
// Verification
// ============================================================================

/** Create verification session */
export async function runCreateVerificationSession(
  ctx: CommandContext,
  includeStatusPolicy: boolean = false,
  includeVicalPolicy: boolean = true
): Promise<void> {
  const step = ctx.nextStep();
  const policies: string[] = [];
  if (includeStatusPolicy) policies.push('status');
  if (includeVicalPolicy) policies.push('vical');
  const policyDesc = policies.length > 0 ? `signature, ${policies.join(', ')}` : 'signature';
  
  ctx.log(`Create verifier2 session (${policyDesc})`, 'RUN');

  const vcPolicies: any[] = [
    { policy: 'signature' },
  ];
  
  if (includeVicalPolicy) {
    const vicalUrl = `${ctx.orgBaseUrl}/v1/${ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;
    vcPolicies.push({
      policy: 'vical',
      vicalUrl: vicalUrl,
      enableDocumentTypeValidation: true,
      enableTrustedChainRoot: true,
    });
  }
  
  if (includeStatusPolicy) {
    vcPolicies.push({
      policy: 'credential-status',
      argument: {
        discriminator: 'ietf',
        value: 0, // Expecting VALID (0x0)
      },
    });
  }

  const request = {
    flow_type: 'cross_device',
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
    },
  };
  ctx.saveJson('create-verification-session-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
    request
  );
  ctx.saveJson('create-verification-session-response.json', response.data, step);

  ctx.ctx.sessionId = response.data.sessionId;
  ctx.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;

  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) {
    throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
  }

  console.log(`   [OK] Verification session created (ID: ${ctx.ctx.sessionId})`);
  console.log(`        Policies: ${policyDesc}`);
}

/** Wallet presents credential */
export async function runWalletPresent(ctx: CommandContext, credentialIds: string[] = []): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Wallet presents credential', 'RUN');
  if (credentialIds.length > 0) {
    console.log(`   [INFO] Wallet2 will auto-select credentials; ignoring explicit IDs: ${credentialIds.join(', ')}`);
  }

  const request: {
    requestUrl: string;
    keyId: string;
    did: string;
  } = {
    requestUrl: ctx.ctx.requestUrl,
    keyId: ctx.ctx.walletKeyRef,
    did: ctx.ctx.walletDid || defaultWalletDidReference(ctx.tenantPath),
  };

  ctx.saveJson('wallet-present-request.json', request, step);

  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/present`,
    request
  );
  ctx.saveJson('wallet-present-response.json', response.data, step);

  console.log(`   [OK] Credential presented`);
}

/** Assert final verification status is SUCCESSFUL */
export async function runAssertFinalStatus(
  ctx: CommandContext,
  verifierPath = `${ctx.tenantPath}.${RESOURCES.verifier2}`,
  fileName = 'final-session-info.json'
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Check verifier2 final session status', 'RUN');

  const response = await ctx.orgClient.get(
    `/v1/${verifierPath}.${ctx.ctx.sessionId}/verifier2-service-api/verification-session/info`
  );
  ctx.saveJson(fileName, response.data, step);

  const finalStatus = response.data.session?.status;

  if (finalStatus !== 'SUCCESSFUL') {
    throw new Error(`Expected SUCCESSFUL but got: ${finalStatus || '<empty>'}`);
  }

  console.log(`   [OK] Final status: ${finalStatus}`);
}

/** Assert final verification status is FAILED */
export async function runAssertFinalStatusFailed(
  ctx: CommandContext,
  verifierPath = `${ctx.tenantPath}.${RESOURCES.verifier2}`,
  fileName = 'final-session-info-failed.json'
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Check verifier2 final session status (expecting FAILED)', 'RUN');

  const response = await ctx.orgClient.get(
    `/v1/${verifierPath}.${ctx.ctx.sessionId}/verifier2-service-api/verification-session/info`
  );
  ctx.saveJson(fileName, response.data, step);

  const finalStatus = response.data.session?.status;

  if (finalStatus !== 'FAILED') {
    throw new Error(`Expected FAILED but got: ${finalStatus || '<empty>'}`);
  }

  console.log(`   [OK] Final status: ${finalStatus} (as expected)`);
}

// ============================================================================
// Credential Status / Revocation
// ============================================================================

/** Revoke credential (set status to INVALID) */
export async function runRevokeCredential(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Revoke credential (set status to INVALID)', 'RUN');

  if (!ctx.ctx.issuerSessionIdWithStatus) {
    throw new Error('No issuer session ID available. Create a credential offer with status first.');
  }

  const request = {
    session: ctx.ctx.issuerSessionIdWithStatus,
    status: '0x1', // INVALID
  };
  ctx.saveJson('revoke-credential-request.json', request, step);

  const response = await ctx.orgClient.put(
    `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}/credential-status-service-api/status-credential/status/update`,
    request
  );
  ctx.saveJson('revoke-credential-response.json', response.data, step);

  console.log(`   [OK] Credential revoked (status set to 0x1 INVALID)`);
}

/** Unrevoke credential (reset status to VALID) */
export async function runUnrevokeCredential(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Unrevoke credential (reset status to VALID)', 'RUN');

  if (!ctx.ctx.issuerSessionIdWithStatus) {
    throw new Error('No issuer session ID available. Create a credential offer with status first.');
  }

  const request = {
    session: ctx.ctx.issuerSessionIdWithStatus,
    status: '0x0', // VALID
  };
  ctx.saveJson('unrevoke-credential-request.json', request, step);

  const response = await ctx.orgClient.put(
    `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}/credential-status-service-api/status-credential/status/update`,
    request
  );
  ctx.saveJson('unrevoke-credential-response.json', response.data, step);

  console.log(`   [OK] Credential unrevoked (status reset to 0x0 VALID)`);
}

/** Update credential status to arbitrary value */
export async function runUpdateCredentialStatus(ctx: CommandContext, status: string): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Update credential status to ${status}`, 'RUN');

  if (!ctx.ctx.issuerSessionIdWithStatus) {
    throw new Error('No issuer session ID available. Create a credential offer with status first.');
  }

  const request = {
    session: ctx.ctx.issuerSessionIdWithStatus,
    status,
  };
  ctx.saveJson('update-status-request.json', request, step);

  const response = await ctx.orgClient.put(
    `/v1/${ctx.tenantPath}.${RESOURCES.credentialStatus}.${STATUS_CONFIG_IDS.tokenStatusListCwt}/credential-status-service-api/status-credential/status/update`,
    request
  );
  ctx.saveJson('update-status-response.json', response.data, step);

  console.log(`   [OK] Credential status updated to ${status}`);
}

// ============================================================================
// Wallet Management
// ============================================================================

/** Clear all credentials from wallet (tries wallet-credentialstore then legacy credentialstore) */
export async function clearWalletCredentials(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Clear all credentials from wallet', 'SETUP');

  const stores = [RESOURCES.walletCredentialStore, RESOURCES.credentialStore];
  let cleared = false;

  for (const store of stores) {
    try {
      const deleteResponse = await ctx.orgClient.delete(
        `/v1/${ctx.tenantPath}.${store}/credential-store-service-api/credentials/delete-all`
      );
      const credentialsDeleted = deleteResponse.data.deleted;
      console.log(`   [OK] Wallet credentials cleared from ${store} (deleted: ${credentialsDeleted})`);
      cleared = true;
    } catch (error: any) {
      if (error.status !== 404) {
        console.log(`   [WARN] Could not clear ${store}: ${error.message}`);
      }
    }
  }

  if (!cleared) {
    console.log(`   [WARN] No wallet credential store found to clear on ${ctx.tenantPath}`);
  }
}
