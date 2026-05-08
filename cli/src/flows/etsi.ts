/**
 * ETSI Trust Lists Flow
 * 
 * Demonstrates trust list verification using the Enterprise Trust Registry Service.
 * This flow assumes the primary setup has been run (tenant, wallet, credentials exist).
 * 
 * Steps:
 * 1. Clear existing credentials from wallet
 * 2. Issue a fresh credential for this flow
 * 3. Create verification session with ETSI trust list policy
 * 4. Present credential and verify against trust registry
 */

import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { RESOURCES, MDL_DOC_TYPE } from '../config.js';
import { setupLogin } from '../commands/setup/index.js';
import {
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runWalletPresent,
  runAssertFinalStatus,
  clearWalletCredentials,
} from '../commands/run.js';

/** Create verification session with ETSI Trust List policy */
async function createEtsiVerificationSession(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create verification session with ETSI Trust List policy', 'FLOW');
  
  const vicalUrl = `${ctx.orgBaseUrl}/v1/${ctx.tenantPath}.${RESOURCES.vical}/vical-service-api/latest`;
  
  const vcPolicies = [
    { policy: 'signature' },
    {
      policy: 'vical',
      vicalUrl: vicalUrl,
      enableDocumentTypeValidation: true,
      enableTrustedChainRoot: true,
    },
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
  ctx.saveJson('create-etsi-verification-session-request.json', request, step);
  
  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
    request
  );
  ctx.saveJson('create-etsi-verification-session-response.json', response.data, step);
  
  ctx.ctx.sessionId = response.data.sessionId;
  ctx.ctx.requestUrl = response.data.bootstrapAuthorizationRequestUrl;
  
  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) {
    throw new Error('Could not extract sessionId or bootstrapAuthorizationRequestUrl');
  }
  
  console.log(`   [OK] Verification session created (ID: ${ctx.ctx.sessionId})`);
  console.log(`        Policies: signature, vical, etsi-trust-list`);
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
      ctx.ctx.walletKeyRef = `${ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
    }

    // Step 1: Clear existing credentials
    console.log('\n--- Step 1: Clear Existing Credentials ---');
    await clearWalletCredentials(ctx);

    // Step 2: Issue a fresh credential for this flow
    console.log('\n--- Step 2: Issue Credential ---');
    await runCreateCredentialOffer(ctx, false);
    await runWalletReceiveCredential(ctx);

    // Step 3: Create verification session with etsi-trust-list policy
    console.log('\n--- Step 3: Create Verification Session with ETSI Trust List Policy ---');
    await createEtsiVerificationSession(ctx);

    // Step 4: Wallet presents credential
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
