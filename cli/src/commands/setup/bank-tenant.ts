/**
 * Bank-tenant setup: a separate tenant with issuer, wallet, verifier,
 * and supporting services (KMS, X509).
 *
 * Reuses the same setup commands and dependency patterns as the main tenant.
 * Configuration is loaded from cli/bank-tenant.env (see bank-tenant.env.example).
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, KEY_IDS, CERT_IDS } from '../../config.js';
import {
  BankTenantConfig,
  buildBankIssuerServiceConfig,
  buildIssuerTarget,
  buildProfileId,
  BANK_CREDENTIAL_TYPES,
  BANK_ISSUER_CREDENTIAL_TYPE_KEYS,
} from '../../bank-tenant-config.js';
import { setupLogin } from './auth.js';
import {
  setupCreateTenant,
  setupCreateServices,
  setupLinkX509Dependencies,
} from './tenant.js';
import {
  setupImportKeys,
  setupCreateIacaCertificate,
  setupCreateDocumentSignerCertificate,
} from './keys.js';

/** Build x5c chain for mso_mdoc profiles (document signer + optional IACA) */
async function buildMdocX5Chain(
  ctx: CommandContext
): Promise<Array<{ type: string; pemEncodedCertificate: string }> | undefined> {
  if (!ctx.ctx.docSignerPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.docSignerCert}/x509-store-api/certificates`
      );
      ctx.ctx.docSignerPem =
        certResponse.data.data?.pem ||
        certResponse.data.certificatePem ||
        certResponse.data.pem;
    } catch {
      return undefined;
    }
  }

  if (!ctx.ctx.iacaPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      ctx.ctx.iacaPem =
        certResponse.data.data?.pem ||
        certResponse.data.certificatePem ||
        certResponse.data.pem;
    } catch {
      // IACA is optional in the chain
    }
  }

  const x5Chain: Array<{ type: string; pemEncodedCertificate: string }> = [
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: ctx.ctx.docSignerPem,
    },
  ];

  if (ctx.ctx.iacaPem) {
    x5Chain.push({
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: ctx.ctx.iacaPem,
    });
  }

  return x5Chain;
}

/** Resolve wallet DID from did-store when wallet was already initialized */
async function resolveWalletDidFromStore(ctx: CommandContext): Promise<string | undefined> {
  try {
    const listResponse = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.walletDidStore}/did-store-service-api/dids/list-did-ids`
    );
    const didIds: string[] =
      listResponse.data?.didIds || listResponse.data?.data || listResponse.data || [];
    if (!Array.isArray(didIds) || didIds.length === 0) {
      return undefined;
    }

    const didResponse = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.walletDidStore}.${didIds[0]}/did-store-service-api/dids`
    );
    return (
      didResponse.data?.did ||
      didResponse.data?.data?.did ||
      didResponse.data?.id
    );
  } catch {
    return undefined;
  }
}

/**
 * Initialize wallet with its own KMS (separate from issuer KMS), DID service/store,
 * credential store, and did:key. Uses init-wallet wizard (wallet-service setup docs).
 */
export async function setupBankCreateWallet(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Initialize bank tenant wallet with dedicated KMS and DID', 'BANK-SETUP');

  const walletKmsRef = `${ctx.tenantPath}.${RESOURCES.walletKms}`;

  const { created, result } = await ctx.tolerantCreate(
    'Wallet',
    async () => {
      const request = {
        createKms: true,
        kmsName: RESOURCES.walletKms,
        createKeyInKms: {
          keyType: 'secp256r1',
        },
        createDidStore: true,
        didStoreName: RESOURCES.walletDidStore,
        createDidService: true,
        didServiceName: RESOURCES.walletDidService,
        createDidWithDidService: 'key',
        createCredentialStore: true,
        credentialStoreName: RESOURCES.walletCredentialStore,
      };
      ctx.saveJson('init-bank-wallet-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}/wallet-service-api/init-wallet`,
        request
      );
      ctx.saveJson('init-bank-wallet-response.json', response.data, step);
      return response;
    }
  );

  ctx.ctx.walletKeyRef = `${walletKmsRef}.wallet_key`;

  const createdDid = result?.data?.createdResources?.did as string | undefined;
  if (createdDid) {
    ctx.ctx.walletDid = createdDid;
  } else if (!ctx.ctx.walletDid) {
    ctx.ctx.walletDid = (await resolveWalletDidFromStore(ctx)) || '';
  }

  if (created) {
    console.log(`   [OK] Wallet initialized (KMS: ${walletKmsRef})`);
    if (ctx.ctx.walletDid) {
      console.log(`   [OK] Wallet DID: ${ctx.ctx.walletDid}`);
    }
  } else if (ctx.ctx.walletDid) {
    console.log(`   [SKIP] Wallet already exists (DID: ${ctx.ctx.walletDid})`);
  }
}

/** Create verifier2 with public baseUrl from bank-tenant.env */
export async function setupBankCreateVerifier(
  ctx: CommandContext,
  bank: BankTenantConfig
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create bank tenant verifier2', 'BANK-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Verifier2 service',
    async () => {
      const request = {
        type: 'verifier2',
        baseUrl: bank.serviceBaseUrl,
        clientId: 'verifier2-client',
      };
      ctx.saveJson('create-bank-verifier2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-bank-verifier2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Verifier2 created (baseUrl: ${bank.serviceBaseUrl})`);
  }
}

/** Create issuer2 with EUDI PID and payment account configuration */
export async function setupBankCreateIssuer(
  ctx: CommandContext,
  bank: BankTenantConfig
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create bank tenant issuer2', 'BANK-SETUP');

  if (!bank.keycloak.authorizeUrl || !bank.keycloak.accessTokenUrl) {
    throw new Error(
      'KEYCLOAK_AUTHORIZE_URL and KEYCLOAK_ACCESS_TOKEN_URL are required in cli/bank-tenant.env'
    );
  }

  const { created } = await ctx.tolerantCreate(
    'Issuer2 service',
    async () => {
      const request = buildBankIssuerServiceConfig(ctx.tenantPath, bank);
      ctx.saveJson('create-bank-issuer2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.issuer}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-bank-issuer2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Issuer2 created (baseUrl: ${bank.serviceBaseUrl})`);
  }
}

/** Create issuer credential profiles for each configured credential type */
export async function setupBankCreateIssuerProfiles(ctx: CommandContext): Promise<void> {
  const issuerTarget = buildIssuerTarget(ctx.tenantPath);
  const issuerKeyId = `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`;

  for (const key of BANK_ISSUER_CREDENTIAL_TYPE_KEYS) {
    const credentialType = BANK_CREDENTIAL_TYPES[key];
    const profileId = buildProfileId(issuerTarget, credentialType.profileSuffix);
    const step = ctx.nextStep();
    ctx.log(`Create issuer profile: ${credentialType.name}`, 'BANK-SETUP');

    const { created } = await ctx.tolerantCreate(
      `Profile ${credentialType.profileSuffix}`,
      async () => {
        const request: Record<string, unknown> = {
          name: credentialType.profileSuffix,
          credentialConfigurationId: credentialType.credentialConfigurationId,
          issuerKeyId,
          credentialData: credentialType.sampleCredentialData,
        };

        if (credentialType.format === 'mso_mdoc') {
          const x5Chain = await buildMdocX5Chain(ctx);
          if (!x5Chain) {
            throw new Error(
              `Document signer certificate required for ${credentialType.name} profile. ` +
                'Ensure setup-create-document-signer-certificate completed successfully.'
            );
          }
          request.x5Chain = x5Chain;
        }

        ctx.saveJson(`create-bank-profile-${credentialType.profileSuffix}-request.json`, request, step);

        const response = await ctx.orgClient.post(
          `/v2/${profileId}/issuer-service-api/credentials/profiles`,
          request
        );
        ctx.saveJson(`create-bank-profile-${credentialType.profileSuffix}-response.json`, response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Profile created: ${profileId}`);
    }
  }
}

/**
 * Run full bank-tenant setup.
 *
 * Same flow as runAllSetup for core services, minus VICAL/trust/attestation.
 * Issuer KMS binding is in the create request; the only issuer dependency
 * link in main setup is credential-status (not used here).
 */
export async function runBankTenantSetup(
  ctx: CommandContext,
  bank: BankTenantConfig
): Promise<void> {
  console.log('\n=== Bank Tenant Setup ===\n');
  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Tenant path: ${ctx.tenantPath}`);
  console.log(`Service base URL: ${bank.serviceBaseUrl}`);
  console.log(`VCT base URL: ${bank.vctBaseUrl}\n`);

  await setupLogin(ctx);
  await setupCreateTenant(ctx);
  await setupBankCreateVerifier(ctx, bank);
  await setupCreateServices(ctx);
  await setupLinkX509Dependencies(ctx);
  await setupBankCreateWallet(ctx);
  await setupImportKeys(ctx);
  await setupCreateIacaCertificate(ctx);
  await setupCreateDocumentSignerCertificate(ctx);
  await setupBankCreateIssuer(ctx, bank);
  await setupBankCreateIssuerProfiles(ctx);

  console.log('\n[BANK-SETUP] Bank tenant setup completed');
}
