#!/usr/bin/env node
/**
 * walt.ts - walt.id Enterprise Stack CLI Tool
 * 
 * Main entry point for the CLI. Handles argument parsing and command dispatch.
 * 
 * Usage:
 *   npx tsx walt.ts                    # Full setup + primary use case
 *   npx tsx walt.ts --recreate         # Recreate DB and setup from scratch
 *   npx tsx walt.ts --setup-all        # Run all setup commands
 *   npx tsx walt.ts --run-all          # Run primary use case (issue + verify)
 *   npx tsx walt.ts --setup-<command>  # Run specific setup command
 *   npx tsx walt.ts --run-<command>    # Run specific run command
 *   npx tsx walt.ts --flow-<name>      # Run a specific flow
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { createConfig } from './config.js';
import { CommandContext } from './context.js';
import { loadWaltEnv } from './env.js';
import { loadBankTenantEnv, createBankTenantConfig } from './bank-tenant-config.js';
import { loadGovServicesEnv, createGovServicesConfig } from './gov-services-config.js';
import { loadEudiDemoEnv, createEudiDemoConfig } from './eudi-demo-config.js';
import {
  // System commands
  runSystemInit,
  recreateDb,
  createSuperadminAccount,
  createOrganization,
  setupCreateAdminRole,
  setupCreateAdminAccount,
  
  // Setup commands
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
  setupCreateTrustRegistry,
  setupEtsiTrustRegistry,
  setupImportTrustList,
  
  // Run commands
  runCreateCredentialOffer,
  runWalletReceiveCredential,
  runCreateVerificationSession,
  runWalletPresent,
  runAssertFinalStatus,
  runAssertFinalStatusFailed,
  runRevokeCredential,
  runUnrevokeCredential,
  runUpdateCredentialStatus,
  clearWalletCredentials,
  
  // Orchestration
  runAllSetup,
  runAllRun,
  runFull,
  runBankTenantSetup,
  runGovServicesSetup,
  runEudiDemoSetup,
} from './commands/index.js';

import { flowEtsiTrustLists, flowCredentialRevocation, flowGovTrust, flowTrustListAssurance } from './flows/index.js';

// ============================================================================
// CLI Setup
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliDir = join(__dirname, '..');

const args = process.argv.slice(2);

// ============================================================================
// Help
// ============================================================================

function printHelp(): void {
  console.log(`
walt.ts - walt.id Enterprise Stack CLI Tool

Usage: npx tsx walt.ts [options]

Default behavior (no options):
  Runs full setup + primary use case (issue and verify mDL credential)

System Commands:
  --recreate              Recreate database and run full setup from scratch
  --init-system           Run system initialization only (no use case)
  --setup-recreate        Recreate database only (alias for --init-system)
  --setup-create-superadmin  Create superadmin account
  --setup-create-organization  Create organization
  --setup-create-admin-role  Create organization admin role
  --setup-create-admin-account  Create admin user account and assign role

Setup Commands (create resources):
  --setup-all             Run all setup commands
  --setup-login           Login to the enterprise stack (uses admin credentials by default)
  --setup-login-superadmin  Login as superadmin
  --setup-create-tenant   Create tenant
  --setup-create-wallet   Create wallet service
  --setup-create-verifier2  Create verifier2 service
  --setup-create-services Create KMS, X509, credential store services
  --setup-link-x509-dependencies  Link X509 service dependencies
  --setup-import-keys     Import cryptographic keys
  --setup-create-iaca-certificate  Create IACA certificate
  --setup-create-document-signer-certificate  Create document signer certificate
  --setup-store-vical-signer-certificate  Store VICAL signer certificate
  --setup-create-vical-service  Create VICAL service
  --setup-publish-vical   Publish VICAL
  --setup-create-client-attester  Create client attester service
  --setup-create-credential-status-service  Create credential status service
  --setup-create-status-configuration  Create TokenStatusList CWT configuration
  --setup-create-issuer2  Create issuer2 service
  --setup-link-issuer-to-credential-status  Link credential status service to issuer
  --setup-create-issuer-profile  Create issuer credential profile
  --setup-link-wallet-to-attester  Link wallet to client attester
  --setup-obtain-wallet-attestation  Obtain wallet attestation
  --setup-bank-tenant     Set up bank-tenant (issuer, wallet, verifier, KMS, X509)
  --setup-gov-services    Set up government services (multi-department issuers, verifier)
  --setup-eudi-demo       Set up EUDI demo (WRP Registry auth, RP certificate, verifier2)

Additional Setup Commands:
  --setup-create-trust-registry  Create trust registry service
  --setup-etsi-trust-registry  Complete ETSI trust registry setup (create, link, import lists)
  --setup-import-trust-list <file>  Import trust list from file
  --clear-wallet-credentials  Clear all credentials from wallet (useful between flows)

Run Commands (execute use cases):
  --run-all               Run primary use case (issue + verify)
  --run-create-credential-offer  Create credential offer
  --run-create-credential-offer-with-status  Create credential offer with status tracking
  --run-wallet-receive-credential  Wallet receives credential
  --run-create-verification-session  Create verification session (signature + vical)
  --run-create-verification-session-with-status  Create verification session (signature + vical + status)
  --run-create-verification-session-status-only  Create verification session (signature + status only, no vical)
  --run-wallet-present    Wallet presents credential
  --run-assert-final-status  Assert final verification status
  --run-assert-final-status-failed  Assert final verification status is FAILED

Credential Revocation Commands:
  --run-revoke-credential  Revoke credential (set status to INVALID)
  --run-unrevoke-credential  Unrevoke credential (reset status to VALID)
  --run-update-credential-status <status>  Update credential status to specified value

Flows (special use cases):
  --flow-etsi-trust-lists  Run ETSI trust lists verification flow
  --flow-trust-list-assurance  Test certificate paths, signed LoTE, and verifier integration
  --flow-credential-revocation  Run credential revocation flow
  --flow-gov-trust         Run government trust list validation flow (requires --setup-gov-services)

Other Options:
  --help, -h              Show this help message

Environment Variables:
  BASE_URL                Enterprise stack base URL (default: enterprise.localhost)
  PORT                    Port number (default: none, uses protocol default)
  ORGANIZATION            Organization ID (default: waltid)
  TENANT                  Tenant ID (default: <organization>-tenant01)
  EMAIL                   Superadmin email (from config/superadmin-registration.conf)
  PASSWORD                Superadmin password (from config/superadmin-registration.conf)
  ADMIN_EMAIL             Admin user email (default: admin@walt.id)
  ADMIN_PASSWORD          Admin user password (default: admin123456)
  SUPERADMIN_TOKEN        Superadmin registration token (from config/superadmin-registration.conf)

General CLI settings (cli/walt.env — copy from walt.env.example):
  HOST_ALIAS_DOMAIN       Custom domain for host alias (used by --recreate / --init-system)
  HOST_ALIAS_TARGET       Host alias service target (default: {ORGANIZATION}.host-alias)
  TRUST_LIST_SIGNED_LOTE_FILE  Optional compact-JWS LoTE file
  TRUST_LIST_SIGNER_CERT_FILE  Independently trusted signer certificate for the JWS

Bank tenant (cli/bank-tenant.env — copy from bank-tenant.env.example):
  BANK_TENANT             Tenant ID (default: bank-tenant)
  BANK_TENANT_BASE_URL    Public base URL for issuer and verifier
  VCT_BASE_URL            Base URL for SD-JWT VCT values
  KEYCLOAK_*              Keycloak OIDC settings for issuer auth

Government services (cli/gov-services.env — copy from gov-services.env.example):
  GOV_TENANT              Central tenant ID (default: gov-central)
  GOV_SERVICES_BASE_URL   Public base URL for issuers and verifier
  GOV_DEPT_*              Department tenant IDs (HR, Identity, Revenue, Finance)

EUDI demo (cli/eudi-demo.env — copy from eudi-demo.env.example):
  EUDI_REGISTRY_BASE_URL  WRP Registry URL (default: https://registry.serviceproviders.eudiw.dev)
  EUDI_TENANT             Tenant ID (default: eudi-demo)
  EUDI_SERVICE_BASE_URL   Public base URL for verifier service
  EUDI_LEGAL_ENTITY_*     Legal entity information for WRP registration
  EUDI_CERTIFICATE_PASSWORD  Password for PKCS#12 certificate

Examples:
  # Full setup and run (default)
  npx tsx walt.ts

  # Recreate database and start fresh
  npx tsx walt.ts --recreate

  # Just run setup commands
  npx tsx walt.ts --setup-all

  # Just run the use case (assumes setup already done)
  npx tsx walt.ts --run-all

  # Run specific setup command
  npx tsx walt.ts --setup-create-wallet

  # Import a trust list
  npx tsx walt.ts --setup-import-trust-list /path/to/trust_list.xml

  # Run ETSI Trust Lists flow (requires primary setup first)
  npx tsx walt.ts                    # First: run full setup
  npx tsx walt.ts --flow-etsi-trust-lists  # Then: run ETSI flow

  # Run with different organization/tenant
  ORGANIZATION=myorg TENANT=myorg-prod npx tsx walt.ts

  # Set up bank-tenant only (requires cli/bank-tenant.env)
  npx tsx walt.ts --setup-bank-tenant

  # Set up government services (requires cli/gov-services.env)
  npx tsx walt.ts --setup-gov-services

  # Set up EUDI demo with WRP Registry (requires cli/eudi-demo.env)
  npx tsx walt.ts --setup-eudi-demo
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  // Check for unknown commands
  const knownArgs = [
    '--help', '-h',
    '--recreate', '--init-system',
    '--setup-all', '--setup-recreate',
    '--setup-login', '--setup-login-superadmin', '--setup-create-tenant', '--setup-create-wallet',
    '--setup-create-verifier2', '--setup-create-services',
    '--setup-link-x509-dependencies', '--setup-import-keys',
    '--setup-create-iaca-certificate', '--setup-create-document-signer-certificate',
    '--setup-store-vical-signer-certificate', '--setup-create-vical-service',
    '--setup-publish-vical', '--setup-create-client-attester',
    '--setup-create-credential-status-service', '--setup-create-status-configuration',
    '--setup-create-issuer2', '--setup-link-issuer-to-credential-status', '--setup-create-issuer-profile',
    '--setup-link-wallet-to-attester', '--setup-obtain-wallet-attestation',
    '--setup-bank-tenant',
    '--setup-gov-services',
    '--setup-eudi-demo',
    '--setup-create-trust-registry', '--setup-etsi-trust-registry', '--setup-import-trust-list',
    '--setup-create-superadmin', '--setup-create-organization',
    '--setup-create-admin-role', '--setup-create-admin-account',
    '--clear-wallet-credentials',
    '--run-all', '--run-create-credential-offer', '--run-create-credential-offer-with-status',
    '--run-wallet-receive-credential',
    '--run-create-verification-session', '--run-create-verification-session-with-status',
    '--run-create-verification-session-status-only',
    '--run-wallet-present', '--run-assert-final-status', '--run-assert-final-status-failed',
    '--run-revoke-credential', '--run-unrevoke-credential', '--run-update-credential-status',
    '--flow-etsi-trust-lists', '--flow-trust-list-assurance', '--flow-credential-revocation', '--flow-gov-trust',
  ];
  
  for (const arg of args) {
    if (!arg.startsWith('--') && !arg.startsWith('-')) continue;
    if (!knownArgs.includes(arg)) {
      console.error(`\n[ERROR] Unknown command: ${arg}`);
      console.error('Run "npx tsx walt.ts --help" to see available commands.\n');
      process.exit(1);
    }
  }

  // Load cli/walt.env (general settings); bank-tenant.env or gov-services.env overrides when used
  loadWaltEnv(cliDir);
  if (args.includes('--setup-bank-tenant')) {
    loadBankTenantEnv(cliDir);
  }
  if (args.includes('--setup-gov-services') || args.includes('--flow-gov-trust')) {
    loadGovServicesEnv(cliDir);
  }
  if (args.includes('--setup-eudi-demo')) {
    loadEudiDemoEnv(cliDir);
  }

  // Create config and context
  const projectRoot = join(cliDir, '..');
  const config = createConfig(projectRoot);
  const ctx = new CommandContext(config, cliDir);

  try {
    if (args.includes('--setup-bank-tenant')) {
      ctx.ensureWorkdir();
      const bankConfig = createBankTenantConfig();
      await runBankTenantSetup(ctx, bankConfig);
      ctx.saveHttpLog();
      return;
    }

    if (args.includes('--setup-gov-services')) {
      ctx.ensureWorkdir();
      const govConfig = createGovServicesConfig();
      await runGovServicesSetup(ctx, govConfig);
      ctx.saveHttpLog();
      return;
    }

    if (args.includes('--setup-eudi-demo')) {
      ctx.ensureWorkdir();
      const eudiConfig = createEudiDemoConfig();
      await runEudiDemoSetup(ctx, eudiConfig);
      ctx.saveHttpLog();
      return;
    }

    // System commands
    if (args.includes('--recreate')) {
      await runSystemInit(ctx);
      await runFull(ctx);
      return;
    }

    if (args.includes('--init-system')) {
      await runSystemInit(ctx);
      return;
    }

    if (args.includes('--setup-recreate')) {
      await runSystemInit(ctx);
      return;
    }

    if (args.includes('--setup-create-superadmin')) {
      await createSuperadminAccount(ctx);
      return;
    }

    if (args.includes('--setup-create-organization')) {
      await createOrganization(ctx);
      return;
    }

    if (args.includes('--setup-create-admin-role')) {
      await setupCreateAdminRole(ctx);
      return;
    }

    if (args.includes('--setup-create-admin-account')) {
      await setupCreateAdminAccount(ctx);
      return;
    }

    // Setup all
    if (args.includes('--setup-all')) {
      ctx.ensureWorkdir();
      await runAllSetup(ctx);
      ctx.saveHttpLog();
      return;
    }

    // Individual setup commands
    const setupCommands: Record<string, () => Promise<void>> = {
      '--setup-login': () => setupLogin(ctx),
      '--setup-login-superadmin': () => setupLogin(ctx, ctx.config.email, ctx.config.password),
      '--setup-create-tenant': () => setupCreateTenant(ctx),
      '--setup-create-wallet': () => setupCreateWallet(ctx),
      '--setup-create-verifier2': () => setupCreateVerifier2(ctx),
      '--setup-create-services': () => setupCreateServices(ctx),
      '--setup-link-x509-dependencies': () => setupLinkX509Dependencies(ctx),
      '--setup-import-keys': () => setupImportKeys(ctx),
      '--setup-create-iaca-certificate': () => setupCreateIacaCertificate(ctx),
      '--setup-create-document-signer-certificate': () => setupCreateDocumentSignerCertificate(ctx),
      '--setup-store-vical-signer-certificate': () => setupStoreVicalSignerCertificate(ctx),
      '--setup-create-vical-service': () => setupCreateVicalService(ctx),
      '--setup-publish-vical': () => setupPublishVical(ctx),
      '--setup-create-client-attester': () => setupCreateClientAttester(ctx),
      '--setup-create-credential-status-service': () => setupCreateCredentialStatusService(ctx),
      '--setup-create-status-configuration': () => setupCreateStatusConfiguration(ctx),
      '--setup-create-issuer2': () => setupCreateIssuer2(ctx),
      '--setup-link-issuer-to-credential-status': () => setupLinkIssuerToCredentialStatus(ctx),
      '--setup-create-issuer-profile': () => setupCreateIssuerProfile(ctx),
      '--setup-link-wallet-to-attester': () => setupLinkWalletToAttester(ctx),
      '--setup-obtain-wallet-attestation': () => setupObtainWalletAttestation(ctx),
      '--setup-create-trust-registry': () => setupCreateTrustRegistry(ctx),
      '--setup-etsi-trust-registry': () => setupEtsiTrustRegistry(ctx),
      '--clear-wallet-credentials': () => clearWalletCredentials(ctx),
    };

    for (const [flag, fn] of Object.entries(setupCommands)) {
      if (args.includes(flag)) {
        ctx.ensureWorkdir();
        await setupLogin(ctx);
        await fn();
        ctx.saveHttpLog();
        return;
      }
    }

    // Import trust list (special case with parameter)
    const importTrustListIndex = args.findIndex(a => a === '--setup-import-trust-list');
    if (importTrustListIndex !== -1) {
      const filePath = args[importTrustListIndex + 1];
      if (!filePath) {
        console.error('Error: --setup-import-trust-list requires a file path');
        process.exit(1);
      }
      ctx.ensureWorkdir();
      await setupLogin(ctx);
      await setupImportTrustList(ctx, filePath);
      ctx.saveHttpLog();
      return;
    }

    // Run commands
    if (args.includes('--run-all')) {
      ctx.ensureWorkdir();
      await runAllRun(ctx);
      ctx.saveHttpLog();
      return;
    }

    const runCommands: Record<string, () => Promise<void>> = {
      '--run-create-credential-offer': () => runCreateCredentialOffer(ctx, false),
      '--run-create-credential-offer-with-status': () => runCreateCredentialOffer(ctx, true),
      '--run-wallet-receive-credential': () => runWalletReceiveCredential(ctx),
      '--run-create-verification-session': () => runCreateVerificationSession(ctx, false, true),
      '--run-create-verification-session-with-status': () => runCreateVerificationSession(ctx, true, true),
      '--run-create-verification-session-status-only': () => runCreateVerificationSession(ctx, true, false),
      '--run-wallet-present': () => runWalletPresent(ctx),
      '--run-assert-final-status': () => runAssertFinalStatus(ctx),
      '--run-assert-final-status-failed': () => runAssertFinalStatusFailed(ctx),
      '--run-revoke-credential': () => runRevokeCredential(ctx),
      '--run-unrevoke-credential': () => runUnrevokeCredential(ctx),
    };

    for (const [flag, fn] of Object.entries(runCommands)) {
      if (args.includes(flag)) {
        ctx.ensureWorkdir();
        await setupLogin(ctx);
        await fn();
        ctx.saveHttpLog();
        return;
      }
    }

    // Update credential status (special case with parameter)
    const updateStatusIndex = args.findIndex(a => a === '--run-update-credential-status');
    if (updateStatusIndex !== -1) {
      const status = args[updateStatusIndex + 1];
      if (!status) {
        console.error('Error: --run-update-credential-status requires a status value (e.g., 0x0, 0x1)');
        process.exit(1);
      }
      ctx.ensureWorkdir();
      await setupLogin(ctx);
      await runUpdateCredentialStatus(ctx, status);
      ctx.saveHttpLog();
      return;
    }

    // Flows
    if (args.includes('--flow-etsi-trust-lists')) {
      await flowEtsiTrustLists(ctx);
      return;
    }

    if (args.includes('--flow-trust-list-assurance')) {
      await flowTrustListAssurance(ctx);
      return;
    }

    if (args.includes('--flow-credential-revocation')) {
      await flowCredentialRevocation(ctx);
      return;
    }

    if (args.includes('--flow-gov-trust')) {
      await flowGovTrust(ctx);
      return;
    }

    // Default: run full setup + use case
    await runFull(ctx);

  } catch (error: any) {
    console.error('\n[ERROR] Operation failed:', error.message);
    
    if (error.cause) {
      console.error('Cause:', error.cause.message || error.cause);
      if (error.cause.code) {
        console.error('Error code:', error.cause.code);
      }
    }
    
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    
    if (process.env.VERBOSE === 'true') {
      console.error('\nStack trace:', error.stack);
    }
    
    try {
      ctx.saveHttpLog();
      console.error(`\nHTTP log saved to: ${ctx.workdir}/walt-http-log.json`);
    } catch (e) {
      // Ignore if we can't save
    }
    
    process.exit(1);
  }
}

main();
