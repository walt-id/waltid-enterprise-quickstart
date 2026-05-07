/**
 * Command registry and orchestration.
 * 
 * This module provides:
 * - Command registration and lookup
 * - Orchestration functions for running all setup/run commands
 * - Full flow execution
 */

import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { RESOURCES } from '../config.js';

// Re-export all commands
export * from './system.js';
export * from './setup/index.js';
export * from './run.js';

// Import for orchestration
import {
  setupLogin,
  setupCreateTenant,
  setupCreateWallet,
  setupCreateVerifier2,
  setupCreateServices,
  setupLinkX509Dependencies,
  setupImportKeys,
  setupCreateIacaCertificate,
  setupCreateDocumentSignerCertificate,
  setupStoreVicalSignerCertificate,
  setupCreateVicalService,
  setupPublishVical,
  setupCreateClientAttester,
  setupCreateCredentialStatusService,
  setupCreateStatusConfiguration,
  setupCreateIssuer2,
  setupLinkIssuerToCredentialStatus,
  setupCreateIssuerProfile,
  setupLinkWalletToAttester,
  setupObtainWalletAttestation,
} from './setup/index.js';

import {
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runCreateVerificationSession,
  runWalletPresent,
  runAssertFinalStatus,
} from './run.js';

// ============================================================================
// Orchestration Functions
// ============================================================================

/** Run all setup commands in sequence */
export async function runAllSetup(ctx: CommandContext): Promise<void> {
  console.log('\n=== Running All Setup Commands ===\n');
  
  await setupLogin(ctx);
  await setupCreateTenant(ctx);
  await setupCreateWallet(ctx);
  await setupCreateVerifier2(ctx);
  await setupCreateServices(ctx);
  await setupLinkX509Dependencies(ctx);
  await setupImportKeys(ctx);
  await setupCreateIacaCertificate(ctx);
  await setupCreateDocumentSignerCertificate(ctx);
  await setupStoreVicalSignerCertificate(ctx);
  await setupCreateVicalService(ctx);
  await setupPublishVical(ctx);
  await setupCreateClientAttester(ctx);
  await setupCreateCredentialStatusService(ctx);
  await setupCreateStatusConfiguration(ctx);
  await setupCreateIssuer2(ctx);
  await setupLinkIssuerToCredentialStatus(ctx);
  await setupCreateIssuerProfile(ctx);
  await setupLinkWalletToAttester(ctx);
  await setupObtainWalletAttestation(ctx);
  
  console.log('\n[SETUP] All setup commands completed');
}

/** Run primary use case (issue + verify) */
export async function runAllRun(ctx: CommandContext): Promise<void> {
  console.log('\n=== Running Primary Use Case ===\n');
  
  // Need to login first if not already
  if (!ctx.ctx.token) {
    await setupLogin(ctx);
  }
  
  // Set wallet key reference if not already set
  if (!ctx.ctx.walletKeyRef) {
    ctx.ctx.walletKeyRef = `${ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;
  }
  
  await runCreateCredentialOffer(ctx);
  await runWalletReceiveCredential(ctx);
  await runCreateVerificationSession(ctx);
  await runWalletPresent(ctx);
  await runAssertFinalStatus(ctx);
  
  console.log('\n[RUN] Primary use case completed successfully');
}

/** Run full setup + use case */
export async function runFull(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  walt.id Enterprise Stack CLI Tool');
  console.log('========================================\n');
  console.log(`Organization: ${ctx.config.organization}`);
  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Working directory: ${ctx.workdir}`);
  
  mkdirSync(ctx.workdir, { recursive: true });
  
  try {
    await runAllSetup(ctx);
    await runAllRun(ctx);
    
    console.log('\n========================================');
    console.log('  SUCCESS - All operations completed');
    console.log('========================================\n');
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}

// ============================================================================
// Command Registry Types
// ============================================================================

/** Command definition */
export interface CommandDefinition {
  name: string;
  description: string;
  category: 'system' | 'setup' | 'run' | 'flow';
  handler: (ctx: CommandContext, ...args: any[]) => Promise<void>;
  requiresLogin?: boolean;
  args?: string[];
}

/** Command categories for help display */
export const COMMAND_CATEGORIES = {
  system: 'System Commands',
  setup: 'Setup Commands',
  run: 'Run Commands',
  flow: 'Flows',
} as const;
