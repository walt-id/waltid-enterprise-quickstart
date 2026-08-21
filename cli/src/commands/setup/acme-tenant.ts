/**
 * Acme-tenant setup: a separate tenant with issuer, wallet, verifier,
 * and supporting services (KMS, X509).
 *
 * Reuses the same setup commands and dependency patterns as the main tenant.
 * Configuration is loaded from cli/acme-tenant.env (see acme-tenant.env.example).
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, KEY_IDS, CERT_IDS } from '../../config.js';
import {
  AcmeTenantConfig,
  buildAcmeIssuerServiceConfig,
  buildAcmeVerifierServiceConfig,
  buildIssuerTarget,
  buildProfileId,
  ACME_CREDENTIAL_TYPES,
  ACME_ISSUER_CREDENTIAL_TYPE_KEYS,
  createAcmeTenantConfig,
  loadAcmeTenantEnv,
} from '../../acme-tenant-config.js';
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

  const x5Chain: Array<{ type: string; pemEncodedCertificate: string }> = [
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: ctx.ctx.docSignerPem,
    },
  ];

  return x5Chain;
}

/** Create verifier2 with public baseUrl from acme-tenant.env */
export async function setupAcmeCreateVerifier(
  ctx: CommandContext,
  acme: AcmeTenantConfig
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create acme tenant verifier2', 'ACME-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Verifier2 service',
    async () => {
      const request = buildAcmeVerifierServiceConfig(ctx.tenantPath, acme);
      ctx.saveJson('create-acme-verifier2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-acme-verifier2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Verifier2 created (baseUrl: ${acme.serviceBaseUrl})`);
  }
}

/** Create issuer2 with acme credentials configuration */
export async function setupAcmeCreateIssuer(
  ctx: CommandContext,
  acme: AcmeTenantConfig
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create acme tenant issuer2', 'ACME-SETUP');

  if (!acme.keycloak.authorizeUrl || !acme.keycloak.accessTokenUrl) {
    throw new Error(
      'KEYCLOAK_AUTHORIZE_URL and KEYCLOAK_ACCESS_TOKEN_URL are required in cli/acme-tenant.env'
    );
  }

  const { created } = await ctx.tolerantCreate(
    'Issuer2 service',
    async () => {
      let attesterPublicJwk: any = undefined;
      if (process.env.WALLET_ATTESTER_KEY_FILE !== undefined) {
        const attesterKey = ctx.loadKeyFile(process.env.WALLET_ATTESTER_KEY_FILE || '');
        attesterPublicJwk = {
          kty: attesterKey.kty,
          crv: attesterKey.crv,
          x: attesterKey.x,
          y: attesterKey.y,
        };
      }

      const request = buildAcmeIssuerServiceConfig(ctx.tenantPath, acme, attesterPublicJwk);
      ctx.saveJson('create-acme-issuer2-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.issuer}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-acme-issuer2-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Issuer2 created (baseUrl: ${acme.serviceBaseUrl})`);
  }
}

/** Create issuer credential profiles for each configured credential type */
export async function setupAcmeCreateIssuerProfiles(ctx: CommandContext): Promise<void> {
  const issuerTarget = buildIssuerTarget(ctx.tenantPath);
  const issuerKeyId = `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`;

  for (const key of ACME_ISSUER_CREDENTIAL_TYPE_KEYS) {
    const credentialType = ACME_CREDENTIAL_TYPES[key];
    const profileId = buildProfileId(issuerTarget, credentialType.profileSuffix);
    const step = ctx.nextStep();
    ctx.log(`Create issuer profile: ${credentialType.name}`, 'ACME-SETUP');

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

        ctx.saveJson(`create-acme-profile-${credentialType.profileSuffix}-request.json`, request, step);

        const response = await ctx.orgClient.post(
          `/v2/${profileId}/issuer-service-api/credentials/profiles`,
          request
        );
        ctx.saveJson(`create-acme-profile-${credentialType.profileSuffix}-response.json`, response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Profile created: ${profileId}`);
    }
  }
}

/**
 * Run full acme-tenant setup.
 *
 * Same flow as runAllSetup for core services, minus VICAL/trust/attestation.
 * Issuer KMS binding is in the create request; the only issuer dependency
 * link in main setup is credential-status (not used here).
 */
export async function runAcmeTenantSetup(
  ctx: CommandContext,
  acme?: AcmeTenantConfig
): Promise<void> {
  console.log('\n=== Acme Tenant Setup ===\n');

  if (!acme) {
    loadAcmeTenantEnv(ctx.cliDir);
    acme = createAcmeTenantConfig();
  }

  console.log(`Tenant: ${ctx.config.tenant}`);
  console.log(`Tenant path: ${ctx.tenantPath}`);
  console.log(`Service base URL: ${acme.serviceBaseUrl}`);
  console.log(`VCT base URL: ${acme.vctBaseUrl}\n`);

  await setupLogin(ctx);
  await setupCreateTenant(ctx);
  await setupAcmeCreateVerifier(ctx, acme);
  await setupCreateServices(ctx);
  await setupLinkX509Dependencies(ctx);
  await setupImportKeys(ctx);
  await setupCreateIacaCertificate(ctx);
  await setupCreateDocumentSignerCertificate(ctx);
  await setupAcmeCreateIssuer(ctx, acme);
  await setupAcmeCreateIssuerProfiles(ctx);

  console.log('\n[ACME-SETUP] Acme tenant setup completed');
}
