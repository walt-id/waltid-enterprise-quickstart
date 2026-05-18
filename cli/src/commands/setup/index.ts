/**
 * Setup commands module exports.
 */

// Authentication
export { setupLogin, setupLoginSuperadmin, setupLoginAdmin } from './auth.js';

// Tenant and services
export {
  setupCreateTenant,
  setupCreateWallet,
  setupCreateVerifier2,
  setupCreateServices,
  setupLinkX509Dependencies,
} from './tenant.js';

// Keys and certificates
export {
  setupImportKeys,
  setupCreateIacaCertificate,
  setupCreateDocumentSignerCertificate,
  setupStoreVicalSignerCertificate,
} from './keys.js';

// Issuer
export {
  setupCreateVicalService,
  setupPublishVical,
  setupCreateClientAttester,
  setupCreateIssuer2,
  setupCreateIssuerProfile,
  setupLinkWalletToAttester,
  setupObtainWalletAttestation,
} from './issuer.js';

// Credential status
export {
  setupCreateCredentialStatusService,
  setupCreateStatusConfiguration,
  setupLinkIssuerToCredentialStatus,
} from './status.js';

// Trust registry
export {
  setupCreateTrustRegistry,
  setupImportTrustList,
  linkVerifier2ToTrustRegistry,
  importPublicTrustLists,
  loadIacaIntoTrustRegistry,
  listTrustSources,
  setupEtsiTrustRegistry,
} from './trust.js';

// Bank tenant
export { runBankTenantSetup } from './bank-tenant.js';

// Government services tenant
export { runGovServicesSetup } from './gov-services.js';
