/**
 * Credential Revocation Flow
 * 
 * Demonstrates the complete credential revocation lifecycle:
 * 1. Clear existing credentials from wallet
 * 2. Issue a credential with status tracking
 * 3. Verify it successfully (status: VALID)
 * 4. Revoke the credential (status: INVALID)
 * 5. Verify it fails with revocation status
 * 6. Unrevoke the credential (status: VALID)
 * 7. Verify it succeeds again
 */

import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { RESOURCES } from '../config.js';
import { setupLogin } from '../commands/setup/index.js';
import {
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runCreateVerificationSession,
  runWalletPresent,
  runAssertFinalStatus,
  runAssertFinalStatusFailed,
  runRevokeCredential,
  runUnrevokeCredential,
  clearWalletCredentials,
} from '../commands/run.js';

/**
 * Run the credential revocation flow.
 * 
 * Prerequisites:
 * - Primary setup must be completed
 * - Credential status service must be set up
 */
export async function flowCredentialRevocation(ctx: CommandContext): Promise<void> {
  console.log('\n=== Flow: Credential Revocation ===\n');
  console.log('This flow demonstrates the complete credential revocation lifecycle:');
  console.log('  1. Clear existing credentials from wallet');
  console.log('  2. Issue a credential with status tracking');
  console.log('  3. Verify it successfully (status: VALID)');
  console.log('  4. Revoke the credential (status: INVALID)');
  console.log('  5. Verify it fails with revocation status');
  console.log('  6. Unrevoke the credential (status: VALID)');
  console.log('  7. Verify it succeeds again\n');
  
  mkdirSync(ctx.workdir, { recursive: true });
  
  try {
    // Ensure we're logged in
    if (!ctx.ctx.token) {
      await setupLogin(ctx);
    }
    
    // Set wallet key reference if not already set
    if (!ctx.ctx.walletKeyRef) {
      ctx.ctx.walletKeyRef = `${ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
    }
    
    console.log('\n--- Step 1: Clear existing credentials ---\n');
    await clearWalletCredentials(ctx);
    
    console.log('\n--- Step 2: Issue credential with status ---\n');
    await runCreateCredentialOffer(ctx, true); // Enable status tracking
    await runWalletReceiveCredential(ctx);
    
    console.log('\n--- Step 3: Verify credential (should succeed) ---\n');
    await runCreateVerificationSession(ctx, true, false); // Status policy only, no VICAL
    await runWalletPresent(ctx);
    await runAssertFinalStatus(ctx);
    
    console.log('\n--- Step 4: Revoke credential ---\n');
    await runRevokeCredential(ctx);
    
    console.log('\n--- Step 5: Verify revoked credential (should fail) ---\n');
    await runCreateVerificationSession(ctx, true, false); // Status policy only, no VICAL
    await runWalletPresent(ctx);
    await runAssertFinalStatusFailed(ctx);
    
    console.log('\n--- Step 6: Unrevoke credential ---\n');
    await runUnrevokeCredential(ctx);
    
    console.log('\n--- Step 7: Verify unrevoked credential (should succeed) ---\n');
    await runCreateVerificationSession(ctx, true, false); // Status policy only, no VICAL
    await runWalletPresent(ctx);
    await runAssertFinalStatus(ctx);
    
    console.log('\n========================================');
    console.log('  Credential Revocation Flow Complete');
    console.log('========================================\n');
    console.log('Successfully demonstrated:');
    console.log('  ✓ Wallet credential cleanup');
    console.log('  ✓ Credential issuance with status tracking');
    console.log('  ✓ Verification with valid status');
    console.log('  ✓ Credential revocation');
    console.log('  ✓ Verification failure for revoked credential');
    console.log('  ✓ Credential unrevocation');
    console.log('  ✓ Verification success after unrevocation');
  } finally {
    ctx.saveHttpLog();
    console.log(`\nLogs saved to: ${ctx.workdir}`);
  }
}
