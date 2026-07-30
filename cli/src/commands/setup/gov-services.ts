/**
 * Government services tenant setup: a multi-department ecosystem with:
 * - Central government tenant (KMS, wallet, verifier)
 * - Department tenants (HR, Identity, Revenue, Finance)
 * - Issuers for each department with various credential formats
 * - Credential profiles for each credential type
 *
 * Configuration is loaded from cli/gov-services.env (see gov-services.env.example).
 */

import { createHash } from 'crypto';
import { CommandContext } from '../../context.js';
import {
  RESOURCES,
  CERT_IDS,
  KEY_IDS,
  defaultWalletKeyReference,
  defaultWalletDidReference,
  pemToX5cCertificate,
} from '../../config.js';
import {
  GovServicesConfig,
  DepartmentConfig,
  CredentialConfig,
  UntrustedDepartmentConfig,
  PHOTO_ID_DOCTYPE,
  PHOTO_ID_NAMESPACE,
  buildDepartmentConfigs,
  buildDepartmentIssuerConfig,
  buildUntrustedDepartmentConfig,
  buildVerifierClientMetadata,
  departmentNeedsDsc,
  GOV_CREDENTIAL_IDS,
  photoIdDefaultValues,
  buildIssuerDisplayConfiguration,
  firstEnv,
  displayEnvNames,
} from '../../gov-services-config.js';
import { setupLogin } from './auth.js';
import {
  setupCreateTenant,
  setupCreateServices,
  setupLinkX509Dependencies,
} from './tenant.js';
import {
  setupImportKeys,
  setupCreateIacaCertificate,
} from './keys.js';

/** Map of department key to their DSC PEM */
const departmentDscPems: Map<string, string> = new Map();
const GOV_VERIFIER_CERT_KEY = 'gov-verifier';

type X5Chain = Array<{ type: string; pemEncodedCertificate: string }>;

/** Compute SHA-256 hash of a certificate's DER encoding to use as client ID (Base64URL encoded) */
function computeCertificateHash(pem: string): string {
  // Extract base64 content from PEM (strip headers and whitespace)
  const base64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  // Decode base64 to get DER bytes
  const der = Buffer.from(base64, 'base64');

  // Hash the DER-encoded certificate and encode as Base64URL (as per OpenID4VP x509_hash spec)
  const hash = createHash('sha256').update(der).digest('base64url');
  return hash;
}

function buildVerifierCertificateJwks(keyId: string, x5Chain: X5Chain): { keys: Array<Record<string, unknown>> } {
  return {
    keys: [
      {
        kty: 'EC',
        use: 'sig',
        kid: keyId,
        x5c: x5Chain.map(cert => pemToX5cCertificate(cert.pemEncodedCertificate)),
      },
    ],
  };
}

/** Convert X5Chain to x5c array (base64-encoded DER certificates) */
function buildX5cArray(x5Chain: X5Chain): string[] {
  return x5Chain.map(cert => pemToX5cCertificate(cert.pemEncodedCertificate));
}

/** Build x5c chain for profiles using a department's DSC */
async function buildDepartmentX5Chain(
  ctx: CommandContext,
  deptKey: string
): Promise<X5Chain | undefined> {
  const dscPem = departmentDscPems.get(deptKey);
  if (!dscPem) {
    return undefined;
  }

  // Get IACA PEM if not already loaded
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

  const x5Chain: X5Chain = [
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: dscPem,
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

/** Create a Document Signer Certificate for a department using their signing key */
async function createDepartmentDsc(
  ctx: CommandContext,
  deptKey: string,
  dept: DepartmentConfig,
  iaca?: { pem: string; keyIdPath: string }
): Promise<string> {
  const dscCertId = `${deptKey}-dsc`;
  ctx.log(`Create DSC for ${dept.name}`, 'GOV-SETUP');

  // Check if certificate already exists
  try {
    const existing = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${dscCertId}/x509-store-api/certificates`
    );
    if (existing.data) {
      const existingPem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
      departmentDscPems.set(deptKey, existingPem);
      console.log(`   [SKIP] DSC for ${dept.name} already exists`);
      return existingPem;
    }
  } catch {
    // Certificate doesn't exist, create it
  }

  let iacaPem = iaca?.pem || ctx.ctx.iacaPem;
  const iacaKeyIdPath = iaca?.keyIdPath || `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`;

  // Ensure we have IACA PEM
  if (!iacaPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
      ctx.ctx.iacaPem = iacaPem;
    } catch {
      throw new Error('IACA certificate not found. Ensure IACA is created before department DSCs.');
    }
  }

  // Use same env-based naming as metadata display
  const displayName = buildIssuerDisplayConfiguration(
    dept.issuerDisplayDefaults.envPrefixes,
    dept.issuerDisplayDefaults.defaultName,
    dept.issuerDisplayDefaults.defaultLogoAltText
  )[0].name;

  const request = {
    storedCertificateId: dscCertId,
    iacaSigner: {
      type: 'iaca-pem-cert-descriptor',
      iacaPemEncodedCertificate: iacaPem,
      iacaKeyDesc: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: iacaKeyIdPath,
      },
    },
    certificateData: {
      country: 'US',
      commonName: `${displayName} Document Signer`,
      crlDistributionPointUri: 'https://gov.example/crl',
    },
    dsKeyDescriptor: {
      type: 'kms-hosted-key-descriptor',
      keyIdPath: dept.signingKeyId,
    },
  };

  ctx.saveJson(`create-dsc-${deptKey}-request.json`, request);

  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/iso/document-signers`,
    request
  );
  ctx.saveJson(`create-dsc-${deptKey}-response.json`, response.data);

  // Retrieve PEM
  const certResp = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${dscCertId}/x509-store-api/certificates`
  );
  const dscPem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
  
  departmentDscPems.set(deptKey, dscPem);
  console.log(`   [OK] DSC created for ${dept.name}`);
  
  return dscPem;
}

/** Create an IACA certificate from a specific KMS key. */
async function createIacaCertificateForKey(
  ctx: CommandContext,
  certId: string,
  keyIdPath: string,
  commonName: string
): Promise<string> {
  ctx.log(`Create IACA certificate: ${commonName}`, 'GOV-SETUP');

  try {
    const existing = await ctx.orgClient.get(
      `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${certId}/x509-store-api/certificates`
    );
    if (existing.data) {
      const pem = existing.data.data?.pem || existing.data.certificatePem || existing.data.pem;
      console.log(`   [SKIP] IACA certificate already exists: ${certId}`);
      return pem;
    }
  } catch {
    // Certificate doesn't exist, create it
  }

  const request = {
    storedCertificateId: certId,
    certificateData: {
      country: 'US',
      commonName, // Already env-based or passed explicitly
      issuerAlternativeNameConf: {
        uri: `https://gov.example/${certId}`,
      },
    },
    iacaKeyDesc: {
      type: 'kms-hosted-key-descriptor',
      keyIdPath,
    },
    vicalEntryComplementaryMetadata: {
      docType: [PHOTO_ID_DOCTYPE],
    },
  };
  ctx.saveJson(`create-iaca-${certId}-request.json`, request);

  await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Service}/x509-service-api/iso/iacas`,
    request
  );

  const certResp = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${certId}/x509-store-api/certificates`
  );
  const pem = certResp.data.data?.pem || certResp.data.certificatePem || certResp.data.pem;
  console.log(`   [OK] IACA certificate created: ${certId}`);
  return pem;
}

/** Create a department tenant */
async function createDepartmentTenant(
  ctx: CommandContext,
  organization: string,
  dept: DepartmentConfig
): Promise<void> {
  const tenantPath = `${organization}.${dept.tenantId}`;
  ctx.log(`Create department tenant: ${dept.name}`, 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    `Tenant ${dept.tenantId}`,
    async () => {
      const request = { name: dept.name };
      const response = await ctx.orgClient.post(
        `/v1/${tenantPath}/resource-api/tenants/create`,
        request
      );
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Department tenant created: ${tenantPath}`);
  }
}

/** Generate a signing key for a department in the central KMS */
async function createDepartmentSigningKey(
  ctx: CommandContext,
  dept: DepartmentConfig
): Promise<void> {
  const keyName = dept.signingKeyId.split('.').pop() || 'signing-key';
  ctx.log(`Create signing key: ${keyName}`, 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    `Key ${keyName}`,
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${dept.signingKeyId}/kms-service-api/keys/generate`,
        {
          backend: 'jwk',
          keyType: 'secp256r1',
        }
      );
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Signing key created: ${dept.signingKeyId}`);
  }
}

async function createGovVerifierCertificate(ctx: CommandContext): Promise<{
  x5Chain: X5Chain;
  certificatePem: string;
  clientId: string;
}> {
  const signingKeyId = `${ctx.tenantPath}.${RESOURCES.kms}.gov-verifier-signing-key`;
  ctx.log('Create central verifier signing certificate', 'GOV-SETUP');

  const { created: keyCreated } = await ctx.tolerantCreate(
    'Key gov-verifier-signing-key',
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${signingKeyId}/kms-service-api/keys/generate`,
        { backend: 'jwk', keyType: 'secp256r1' }
      );
      return response;
    }
  );
  if (keyCreated) {
    console.log(`   [OK] Central verifier signing key created: ${signingKeyId}`);
  }

  const verifierDeptForDsc: DepartmentConfig = {
    tenantId: ctx.config.tenant,
    name: 'Government Services Verifier',
    issuerName: RESOURCES.verifier2,
    signingKeyId,
    issuerDisplayDefaults: {
      envPrefixes: ['GOV_CENTRAL_VERIFIER', 'GOV_VERIFIER'],
      defaultName: 'Government Services Verifier',
      defaultLogoAltText: 'Government services verifier logo',
      defaultLogoPath: '/logos/gov-central-verifier.png',
    },
    credentials: [],
  };

  const certificatePem = await createDepartmentDsc(ctx, GOV_VERIFIER_CERT_KEY, verifierDeptForDsc);
  const x5Chain = await buildDepartmentX5Chain(ctx, GOV_VERIFIER_CERT_KEY);
  if (!x5Chain) {
    throw new Error('Central verifier certificate chain could not be built');
  }

  // Use certificate hash as client_id (cryptographically tied to the DSC)
  const clientId = "x509_hash:" + computeCertificateHash(certificatePem);

  return { x5Chain, certificatePem, clientId };
}

/** Create issuer service for a department */
async function createDepartmentIssuer(
  ctx: CommandContext,
  organization: string,
  deptKey: string,
  dept: DepartmentConfig,
  gov: GovServicesConfig
): Promise<void> {
  const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;
  ctx.log(`Create issuer: ${dept.name}`, 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    `Issuer ${dept.issuerName}`,
    async () => {
      const dscPem = departmentDscPems.get(deptKey);
      if (!dscPem) {
        throw new Error(`Document signer certificate required for signed metadata: ${dept.name}`);
      }

      const request = buildDepartmentIssuerConfig(organization, ctx.tenantPath, dept, gov, dscPem);
      ctx.saveJson(`create-issuer-${dept.tenantId}-request.json`, request);

      const response = await ctx.orgClient.post(
        `/v1/${issuerPath}/resource-api/services/create`,
        request
      );
      ctx.saveJson(`create-issuer-${dept.tenantId}-response.json`, response.data);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Issuer created: ${issuerPath}`);
  }
}


/** Create credential profiles for a department's issuer */
async function createDepartmentProfiles(
  ctx: CommandContext,
  organization: string,
  deptKey: string,
  dept: DepartmentConfig
): Promise<void> {
  const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;

  for (const cred of dept.credentials) {
    const profileId = `${issuerPath}.${cred.profileSuffix}`;
    const step = ctx.nextStep();
    ctx.log(`Create profile: ${cred.id} (${cred.format})`, 'GOV-SETUP');

    const { created } = await ctx.tolerantCreate(
      `Profile ${cred.profileSuffix}`,
      async () => {
        // Always use the department's signing key
        const request: Record<string, unknown> = {
          name: cred.profileSuffix,
          credentialConfigurationId: cred.id,
          issuerKeyId: dept.signingKeyId,
          credentialData: cred.sampleData,
        };

        // Add W3C VC specific fields for jwt_vc_json credentials
        if (cred.format === 'jwt_vc_json') {
          if (cred.mapping) {
            request.mapping = cred.mapping;
          }
        }

        if (cred.idTokenClaimsMapping) {
          request.idTokenClaimsMapping = cred.idTokenClaimsMapping;
        }

        // Add x5Chain for X.509-backed credentials (mdoc, W3C JWT VC, and SD-JWT VC)
        if (cred.format === 'mso_mdoc' || cred.format === 'jwt_vc_json' || cred.format === 'dc+sd-jwt') {
          const x5Chain = await buildDepartmentX5Chain(ctx, deptKey);
          if (!x5Chain) {
            throw new Error(
              `Document signer certificate required for ${cred.id} profile. ` +
                'Ensure department DSC is created before profiles.'
            );
          }
          request.x5Chain = x5Chain;
        }

        ctx.saveJson(`create-profile-${cred.profileSuffix}-request.json`, request, step);

        const response = await ctx.orgClient.post(
          `/v2/${profileId}/issuer-service-api/credentials/profiles`,
          request
        );
        ctx.saveJson(`create-profile-${cred.profileSuffix}-response.json`, response.data, step);
        return response;
      }
    );

    if (created) {
      console.log(`   [OK] Profile created: ${profileId}`);
    }
  }
}

/** Create trust registry service for gov tenant */
async function createGovTrustRegistry(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create trust registry service', 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Trust registry service',
    async () => {
      const request = { type: 'trust-registry' };
      ctx.saveJson('create-gov-trust-registry-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-gov-trust-registry-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Trust registry created: ${ctx.tenantPath}.${RESOURCES.trustRegistry}`);
  }
}

/** Link central verifier to trust registry */
async function linkGovVerifierToTrustRegistry(ctx: CommandContext): Promise<void> {
  ctx.log('Link central verifier to trust registry', 'GOV-SETUP');

  const trustRegistryTarget = `${ctx.tenantPath}.${RESOURCES.trustRegistry}`;
  const verifierTarget = `${ctx.tenantPath}.${RESOURCES.verifier2}`;

  try {
    await ctx.orgClient.postRaw(
      `/v1/${verifierTarget}/verifier2-service-api/dependencies/add`,
      trustRegistryTarget
    );
    console.log(`   [OK] Trust registry linked to verifier`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Trust registry already linked to verifier`);
    } else {
      throw error;
    }
  }
}

/** Link verifier to KMS for DSC key access */
async function linkVerifierToKms(
  ctx: CommandContext,
  verifierPath: string,
  kmsPath: string,
  verifierName: string
): Promise<void> {
  ctx.log(`Link ${verifierName} to KMS`, 'GOV-SETUP');

  try {
    await ctx.orgClient.postRaw(
      `/v1/${verifierPath}/verifier2-service-api/dependencies/add`,
      kmsPath
    );
    console.log(`   [OK] KMS linked to ${verifierName}`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] KMS already linked to ${verifierName}`);
    } else {
      throw error;
    }
  }
}

/** Link central wallet to trust registry for signed issuer metadata trust checks */
async function linkGovWalletToTrustRegistry(ctx: CommandContext): Promise<void> {
  ctx.log('Link central wallet to trust registry', 'GOV-SETUP');

  const trustRegistryTarget = `${ctx.tenantPath}.${RESOURCES.trustRegistry}`;
  const walletTarget = `${ctx.tenantPath}.${RESOURCES.wallet}`;

  try {
    await ctx.orgClient.postRaw(
      `/v1/${walletTarget}/wallet-service-api/dependencies/add`,
      trustRegistryTarget
    );
    console.log(`   [OK] Trust registry linked to wallet`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] Trust registry already linked to wallet`);
    } else {
      throw error;
    }
  }
}

/** Load all trusted government issuers into the trust registry */
async function loadGovIssuersIntoTrustRegistry(
  ctx: CommandContext,
  organization: string,
  departments: Record<string, DepartmentConfig>,
  gov: GovServicesConfig,
  trustedVerifierCertificatePem?: string
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Load trusted government issuers into trust registry', 'GOV-SETUP');

  const sourceId = gov.trustedSourceId;

  const trustedEntities: any[] = [];

  for (const [deptKey, dept] of Object.entries(departments)) {
    const dscPem = departmentDscPems.get(deptKey);
    const entityId = `gov-${deptKey}`;

    const identities: any[] = [];

    if (dscPem) {
      identities.push({
        matchType: 'CERTIFICATE_PEM',
        value: dscPem,
      });
    }

    if (identities.length === 0) {
      console.log(`   [WARN] ${dept.name} has no identity for trust registry, skipping`);
      continue;
    }

    const credentialTypes = dept.credentials.map(c => c.id);

    // Use same env-based naming as metadata display
    const displayName = buildIssuerDisplayConfiguration(
      dept.issuerDisplayDefaults.envPrefixes,
      dept.issuerDisplayDefaults.defaultName,
      dept.issuerDisplayDefaults.defaultLogoAltText
    )[0].name;

    trustedEntities.push({
      entityId,
      entityType: 'PID_PROVIDER',
      legalName: displayName,
      country: 'US',
      services: [
        {
          serviceId: `${deptKey}-credential-issuing`,
          serviceType: 'CREDENTIAL_ISSUER',
          status: 'GRANTED',
          statusStart: new Date().toISOString(),
          identities,
        },
      ],
    });
  }

  if (trustedVerifierCertificatePem) {
    // Use same env-based naming as metadata display
    const verifierDisplayName = buildVerifierClientMetadata(
      ['GOV_CENTRAL_VERIFIER', 'GOV_VERIFIER'],
      'Government Services Verifier'
    ).client_name;

    trustedEntities.push({
      entityId: 'gov-central-verifier',
      entityType: 'VERIFIER',
      legalName: verifierDisplayName,
      country: 'US',
      services: [
        {
          serviceId: 'gov-central-verification',
          serviceType: 'VERIFIER',
          status: 'GRANTED',
          statusStart: new Date().toISOString(),
          identities: [
            {
              matchType: 'CERTIFICATE_PEM',
              value: trustedVerifierCertificatePem,
            },
          ],
        },
      ],
    });
  }

  const loteSource = {
    listMetadata: {
      listId: sourceId,
      listType: 'credential-issuers',
      territory: 'US',
      issueDate: new Date().toISOString(),
      nextUpdate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      sequenceNumber: '1',
    },
    trustedEntities,
  };

  ctx.saveJson('gov-trust-lote-source.json', loteSource, step);

  const request = {
    sourceId,
    content: JSON.stringify(loteSource),
    sourceUrl: 'local://gov-services-demo',
    validateSignature: false,
  };
  ctx.saveJson('gov-trust-load-request.json', request, step);

  try {
    const response = await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.trustRegistry}/trust-registry-api/sources/load`,
      request
    );
    ctx.saveJson('gov-trust-load-response.json', response.data, step);

    if (!response.data.success) {
      throw new Error(`Trust registry load failed: ${response.data.error || 'unknown error'}`);
    }

    ctx.ctx.trustRegistrySourceId = sourceId;
    console.log(`   [OK] Trust source loaded: ${sourceId}`);
    console.log(`        Entities: ${response.data.entitiesLoaded || 0}`);
    console.log(`        Services: ${response.data.servicesLoaded || 0}`);
    console.log(`        Identities: ${response.data.identitiesLoaded || 0}`);
  } catch (error: any) {
    const errMsg = error.message || '';
    if (error.status === 409 ||
        errMsg.includes('Duplicate target') ||
        errMsg.includes('already exists') ||
        errMsg.includes('Overwriting targets')) {
      ctx.ctx.trustRegistrySourceId = sourceId;
      console.log(`   [SKIP] Gov trust source already exists: ${sourceId}`);
    } else {
      throw new Error(`Failed to load gov trust source: ${errMsg}`);
    }
  }
}

/** Create untrusted department: tenant + issuer + verifier NOT in trust registry */
async function createUntrustedDepartment(
  ctx: CommandContext,
  organization: string,
  untrusted: UntrustedDepartmentConfig,
  gov: GovServicesConfig
): Promise<void> {
  ctx.log('Create untrusted department (negative test cases)', 'GOV-SETUP');

  const tenantPath = `${organization}.${untrusted.tenantId}`;
  const issuerPath = `${tenantPath}.${untrusted.issuerName}`;
  const profileId = `${issuerPath}.${untrusted.credentialProfileSuffix}`;

  // 1. Create untrusted tenant
  const { created: tenantCreated } = await ctx.tolerantCreate(
    `Tenant ${untrusted.tenantId}`,
    async () => {
      const request = { name: 'Untrusted Department (Demo)' };
      const response = await ctx.orgClient.post(
        `/v1/${tenantPath}/resource-api/tenants/create`,
        request
      );
      return response;
    }
  );
  if (tenantCreated) {
    console.log(`   [OK] Untrusted tenant created: ${tenantPath}`);
  }

  // 2. Create signing keys for the untrusted issuer and its private IACA
  const untrustedIacaKeyId = `${ctx.tenantPath}.${RESOURCES.kms}.untrusted-iaca-key`;
  const keyName = untrusted.signingKeyId.split('.').pop() || 'signing-key';
  const { created: keyCreated } = await ctx.tolerantCreate(
    `Key ${keyName}`,
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${untrusted.signingKeyId}/kms-service-api/keys/generate`,
        { backend: 'jwk', keyType: 'secp256r1' }
      );
      return response;
    }
  );
  if (keyCreated) {
    console.log(`   [OK] Untrusted signing key created: ${untrusted.signingKeyId}`);
  }

  const { created: iacaKeyCreated } = await ctx.tolerantCreate(
    'Key untrusted-iaca-key',
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${untrustedIacaKeyId}/kms-service-api/keys/generate`,
        { backend: 'jwk', keyType: 'secp256r1' }
      );
      return response;
    }
  );
  if (iacaKeyCreated) {
    console.log(`   [OK] Untrusted IACA key created: ${untrustedIacaKeyId}`);
  }

  // 3. Create a private IACA + DSC for the untrusted issuer. Neither is loaded
  // into the trust registry, so trust-list validation has a real negative case.
  const untrustedIacaName = firstEnv(
    displayEnvNames(['GOV_UNTRUSTED_ISSUER', 'GOV_ISSUER'], 'IACA_NAME'),
    'Untrusted Department Test IACA'
  );
  const untrustedIacaPem = await createIacaCertificateForKey(
    ctx,
    'untrusted-iaca-cert',
    untrustedIacaKeyId,
    untrustedIacaName
  );

  const untrustedDeptForDsc: DepartmentConfig = {
    tenantId: untrusted.tenantId,
    name: 'Untrusted Department',
    issuerName: untrusted.issuerName,
    signingKeyId: untrusted.signingKeyId,
    issuerDisplayDefaults: {
      envPrefixes: ['GOV_UNTRUSTED_ISSUER', 'GOV_ISSUER'],
      defaultName: 'Untrusted Department Issuer',
      defaultLogoAltText: 'Untrusted department issuer logo',
      defaultLogoPath: '/logos/gov-untrusted-issuer.png',
    },
    credentials: [
      {
        id: GOV_CREDENTIAL_IDS.photoId,
        format: 'mso_mdoc',
        doctype: PHOTO_ID_DOCTYPE,
        profileSuffix: untrusted.credentialProfileSuffix,
        sampleData: { ...photoIdDefaultValues },
      },
    ],
  };
  const untrustedDscPem = await createDepartmentDsc(ctx, 'untrusted', untrustedDeptForDsc, {
    pem: untrustedIacaPem,
    keyIdPath: untrustedIacaKeyId,
  });
  if (!untrustedDscPem) {
    throw new Error('Untrusted issuer DSC required for Photo ID profile');
  }
  const untrustedX5Chain = [
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: untrustedDscPem,
    },
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: untrustedIacaPem,
    },
  ];

  // 3b. Create a separate DSC for the untrusted verifier
  const untrustedVerifierSigningKeyId = `${ctx.tenantPath}.${RESOURCES.kms}.untrusted-verifier-signing-key`;
  const { created: verifierKeyCreated } = await ctx.tolerantCreate(
    'Key untrusted-verifier-signing-key',
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${untrustedVerifierSigningKeyId}/kms-service-api/keys/generate`,
        { backend: 'jwk', keyType: 'secp256r1' }
      );
      return response;
    }
  );
  if (verifierKeyCreated) {
    console.log(`   [OK] Untrusted verifier signing key created: ${untrustedVerifierSigningKeyId}`);
  }

  const untrustedVerifierDeptForDsc: DepartmentConfig = {
    tenantId: untrusted.tenantId,
    name: 'Untrusted Department Verifier',
    issuerName: untrusted.verifierName,
    signingKeyId: untrustedVerifierSigningKeyId,
    issuerDisplayDefaults: {
      envPrefixes: ['GOV_UNTRUSTED_VERIFIER', 'GOV_VERIFIER'],
      defaultName: 'Untrusted Department Verifier',
      defaultLogoAltText: 'Untrusted department verifier logo',
      defaultLogoPath: '/logos/gov-untrusted-verifier.png',
    },
    credentials: [],
  };
  const untrustedVerifierDscPem = await createDepartmentDsc(
    ctx,
    'untrusted-verifier',
    untrustedVerifierDeptForDsc,
    { pem: untrustedIacaPem, keyIdPath: untrustedIacaKeyId }
  );
  // Use certificate hash as client_id (cryptographically tied to the DSC)
  const untrustedVerifierClientId = "x509_hash:" + computeCertificateHash(untrustedVerifierDscPem);
  const untrustedVerifierX5Chain = [
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: untrustedVerifierDscPem,
    },
    {
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: untrustedIacaPem,
    },
  ];

  // 4. Create untrusted issuer service
  const issuerConfig = buildDepartmentIssuerConfig(
    organization,
    ctx.tenantPath,
    untrustedDeptForDsc,
    gov,
    untrustedDscPem
  );

  const { created: issuerCreated } = await ctx.tolerantCreate(
    `Issuer ${untrusted.issuerName}`,
    async () => {
      ctx.saveJson('create-untrusted-issuer-request.json', issuerConfig);
      const response = await ctx.orgClient.post(
        `/v1/${issuerPath}/resource-api/services/create`,
        issuerConfig
      );
      ctx.saveJson('create-untrusted-issuer-response.json', response.data);
      return response;
    }
  );
  if (issuerCreated) {
    console.log(`   [OK] Untrusted issuer created: ${issuerPath}`);
  }

  // 5. Create credential profile for untrusted issuer
  const step = ctx.nextStep();
  ctx.log('Create untrusted issuer credential profile', 'GOV-SETUP');

  const profileRequest: Record<string, unknown> = {
    name: untrusted.credentialProfileSuffix,
    credentialConfigurationId: GOV_CREDENTIAL_IDS.photoId,
    issuerKeyId: untrusted.signingKeyId,
    credentialData: {
      [PHOTO_ID_NAMESPACE]: {
        ...photoIdDefaultValues[PHOTO_ID_NAMESPACE],
        issuing_authority: 'Untrusted Department',
        document_number: 'UNTRUSTED-ID-2024-001',
      },
    },
    x5Chain: untrustedX5Chain,
  };

  ctx.saveJson('create-untrusted-profile-request.json', profileRequest, step);

  const { created: profileCreated } = await ctx.tolerantCreate(
    `Profile ${untrusted.credentialProfileSuffix}`,
    async () => {
      const response = await ctx.orgClient.post(
        `/v2/${profileId}/issuer-service-api/credentials/profiles`,
        profileRequest
      );
      ctx.saveJson('create-untrusted-profile-response.json', response.data, step);
      return response;
    }
  );
  if (profileCreated) {
    console.log(`   [OK] Untrusted profile created: ${profileId}`);
  }

  // 6. Create untrusted verifier (NOT linked to trust registry)
  ctx.log('Create untrusted verifier (no trust registry)', 'GOV-SETUP');
  const verifierPath = `${tenantPath}.${untrusted.verifierName}`;

  const { created: verifierCreated } = await ctx.tolerantCreate(
    `Verifier ${untrusted.verifierName}`,
    async () => {
      const verifierRequest = {
        type: 'verifier2',
        baseUrl: gov.serviceBaseUrl,
        clientId: untrustedVerifierClientId,
        x5c: buildX5cArray(untrustedVerifierX5Chain),
        clientMetadata: buildVerifierClientMetadata(
          ['GOV_UNTRUSTED_VERIFIER', 'GOV_VERIFIER'],
          'Untrusted Department Verifier',
          `${gov.serviceBaseUrl}/logos/gov-untrusted-verifier.png`,
          buildVerifierCertificateJwks(untrustedVerifierClientId, untrustedVerifierX5Chain)
        ),
      };
      ctx.saveJson('create-untrusted-verifier-request.json', verifierRequest);
      const response = await ctx.orgClient.post(
        `/v1/${verifierPath}/resource-api/services/create`,
        verifierRequest
      );
      ctx.saveJson('create-untrusted-verifier-response.json', response.data);
      return response;
    }
  );
  if (verifierCreated) {
    console.log(`   [OK] Untrusted verifier created: ${verifierPath} (clientId: ${untrustedVerifierClientId})`);
  }

  // 7. Link untrusted verifier to KMS (for DSC key access)
  const centralKmsPath = `${ctx.tenantPath}.${RESOURCES.kms}`;
  await linkVerifierToKms(ctx, verifierPath, centralKmsPath, 'untrusted verifier');
}
async function createGovVerifier(
  ctx: CommandContext,
  gov: GovServicesConfig,
  verifierCertificate: { x5Chain: X5Chain; clientId: string }
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create central government verifier', 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Verifier service',
    async () => {
      const request = {
        type: 'verifier2',
        baseUrl: gov.serviceBaseUrl,
        clientId: verifierCertificate.clientId,
        x5c: buildX5cArray(verifierCertificate.x5Chain),
        clientMetadata: buildVerifierClientMetadata(
          ['GOV_CENTRAL_VERIFIER', 'GOV_VERIFIER'],
          'Government Services Verifier',
          `${gov.serviceBaseUrl}/logos/gov-central-verifier.png`,
          buildVerifierCertificateJwks(verifierCertificate.clientId, verifierCertificate.x5Chain)
        ),
      };
      ctx.saveJson('create-gov-verifier-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/resource-api/services/create`,
        request
      );
      ctx.saveJson('create-gov-verifier-response.json', response.data, step);
      return response;
    }
  );

  if (created) {
    console.log(`   [OK] Verifier created (clientId: ${verifierCertificate.clientId})`);
  }
}

/** Initialize wallet for central government tenant */
async function createGovWallet(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Initialize central government wallet with holder DID', 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
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
      ctx.saveJson('init-gov-wallet-request.json', request, step);

      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}/wallet-service-api/init-wallet`,
        request
      );
      ctx.saveJson('init-gov-wallet-response.json', response.data, step);
      return response;
    }
  );

  ctx.ctx.walletKeyRef = defaultWalletKeyReference(ctx.tenantPath);
  ctx.ctx.walletDid = defaultWalletDidReference(ctx.tenantPath);

  if (created) {
    console.log(`   [OK] Wallet initialized`);
  } else {
    console.log(`   [SKIP] Wallet already exists`);
  }
}

/**
 * Run full government services tenant setup.
 *
 * Creates:
 * 1. Central government tenant with KMS and wallet
 * 2. X.509 services and IACA certificate
 * 4. Department tenants (HR, Identity, Revenue, Finance)
 * 5. Signing keys for each department (in central KMS)
 * 6. DSCs for departments (using their signing key)
 * 7. Central verifier certificate (loaded into trust registry)
 * 8. Trust registry service (linked to verifier)
 * 9. Issuers for each department
 * 10. Credential profiles for each credential type
 * 11. All trusted issuers and central verifier loaded into trust registry (DSCs)
 * 12. Untrusted department with issuer + verifier (for negative test cases)
 */
export async function runGovServicesSetup(
  ctx: CommandContext,
  gov: GovServicesConfig
): Promise<void> {
  console.log('\n=== Government Services Tenant Setup ===\n');
  console.log(`Central tenant: ${ctx.config.tenant}`);
  console.log(`Tenant path: ${ctx.tenantPath}`);
  console.log(`Service base URL: ${gov.serviceBaseUrl}`);
  console.log(`VCT base URL: ${gov.vctBaseUrl}`);
  console.log(`Trust source ID: ${gov.trustedSourceId}`);
  console.log(`Departments: ${Object.values(gov.departments).join(', ')}\n`);

  const organization = ctx.config.organization;
  const departments = buildDepartmentConfigs(organization, gov);
  const untrustedDept = buildUntrustedDepartmentConfig(organization, gov);

  // Clear any previous certificate mappings
  departmentDscPems.clear();

  await setupLogin(ctx);

  // 1. Create central government tenant and core services
  await setupCreateTenant(ctx);
  await setupCreateServices(ctx);
  await setupLinkX509Dependencies(ctx);
  await createGovWallet(ctx);

  // 2. Import keys and create IACA certificate (needed for department DSCs)
  await setupImportKeys(ctx);
  await setupCreateIacaCertificate(ctx);

  // 3. Create department tenants
  for (const dept of Object.values(departments)) {
    await createDepartmentTenant(ctx, organization, dept);
  }

  // 4. Create signing keys for each department (in central KMS)
  for (const dept of Object.values(departments)) {
    await createDepartmentSigningKey(ctx, dept);
  }

  // 5. Create DSCs for departments with credentials
  for (const [deptKey, dept] of Object.entries(departments)) {
    if (departmentNeedsDsc(dept)) {
      await createDepartmentDsc(ctx, deptKey, dept);
    }
  }

  // 7. Create a certificate-backed central verifier. Its certificate is loaded
  // into the gov trust source below.
  const govVerifierCertificate = await createGovVerifierCertificate(ctx);
  await createGovVerifier(ctx, gov, govVerifierCertificate);

  // 7b. Link central verifier to KMS (for DSC key access)
  const centralKmsPath = `${ctx.tenantPath}.${RESOURCES.kms}`;
  const centralVerifierPath = `${ctx.tenantPath}.${RESOURCES.verifier2}`;
  await linkVerifierToKms(ctx, centralVerifierPath, centralKmsPath, 'central verifier');

  // 8. Create trust registry and link services
  await createGovTrustRegistry(ctx);
  await linkGovVerifierToTrustRegistry(ctx);
  await linkGovWalletToTrustRegistry(ctx);

  // 9. Create issuers for each department
  for (const [deptKey, dept] of Object.entries(departments)) {
    await createDepartmentIssuer(ctx, organization, deptKey, dept, gov);
  }

  // 10. Create credential profiles
  for (const [deptKey, dept] of Object.entries(departments)) {
    await createDepartmentProfiles(ctx, organization, deptKey, dept);
  }

  // 11. Load all trusted issuers and the central verifier into trust registry
  await loadGovIssuersIntoTrustRegistry(
    ctx,
    organization,
    departments,
    gov,
    govVerifierCertificate.certificatePem
  );

  // 12. Create untrusted department (issuer + verifier for negative cases)
  await createUntrustedDepartment(ctx, organization, untrustedDept, gov);

  console.log('\n[GOV-SETUP] Government services tenant setup completed');
  console.log('\nTrusted issuers (in trust registry):');
  for (const [deptKey, dept] of Object.entries(departments)) {
    const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;
    const hasDsc = departmentDscPems.has(deptKey);
    console.log(`  - ${dept.name}: ${issuerPath}`);
    if (hasDsc) {
      console.log(`      DSC: ${deptKey}-dsc`);
    }
    for (const cred of dept.credentials) {
      console.log(`      Profile: ${issuerPath}.${cred.profileSuffix} (${cred.id}, ${cred.format})`);
    }
  }
  console.log('\nUntrusted department (NOT in trust registry):');
  console.log(`  - Tenant: ${organization}.${untrustedDept.tenantId}`);
  console.log(`  - Issuer: ${organization}.${untrustedDept.tenantId}.${untrustedDept.issuerName}`);
  console.log(`    Profile: ${organization}.${untrustedDept.tenantId}.${untrustedDept.issuerName}.${untrustedDept.credentialProfileSuffix}`);
  console.log(`  - Verifier (certificate NOT in trust registry): ${organization}.${untrustedDept.tenantId}.${untrustedDept.verifierName}`);
  console.log(`\nTrust registry source ID: ${gov.trustedSourceId}`);
}
