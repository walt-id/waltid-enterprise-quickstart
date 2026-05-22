/**
 * Government services tenant setup: a multi-department ecosystem with:
 * - Central government tenant (KMS, wallet, verifier)
 * - Department tenants (HR, Identity, Revenue, Finance)
 * - Issuers for each department with various credential formats
 * - Credential profiles for each credential type
 *
 * Configuration is loaded from cli/gov-services.env (see gov-services.env.example).
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, CERT_IDS, KEY_IDS, defaultWalletKeyReference, defaultWalletDidReference } from '../../config.js';
import {
  GovServicesConfig,
  DepartmentConfig,
  CredentialConfig,
  UntrustedDepartmentConfig,
  PHOTO_ID_DOCTYPE,
  buildDepartmentConfigs,
  buildDepartmentIssuerConfig,
  buildUntrustedDepartmentConfig,
  buildIssuerDisplayConfiguration,
  buildVerifierClientMetadata,
  departmentNeedsDsc,
  GOV_CREDENTIAL_IDS,
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

/** Map of department key to their DSC PEM (for X.509-backed issuers) */
const departmentDscPems: Map<string, string> = new Map();

const W3C_X509_MAPPING = {
  id: '<uuid>',
  issuanceDate: '<timestamp>',
  expirationDate: '<timestamp-in:365d>',
};

function buildEmployeeStatusCredentialData(
  issuerName: string,
  issuerUrl: string
): Record<string, unknown> {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://purl.imsglobal.org/spec/ob/v3p0/context.json'],
    id: 'urn:uuid:placeholder',
    type: ['VerifiableCredential', GOV_CREDENTIAL_IDS.employeeStatus],
    name: 'Employee Status',
    issuanceDate: '2024-01-01T00:00:00Z',
    issuer: {
      type: ['Profile'],
      name: issuerName,
      url: issuerUrl,
    },
    credentialSubject: {
      type: ['Person'],
      employeeId: 'EMP-2024-999',
      department: issuerName,
      position: 'Contractor',
      clearanceLevel: 'None',
      startDate: '2024-01-15',
    },
  };
}

/** Build x5c chain for profiles using a department's DSC */
async function buildDepartmentMdocX5Chain(
  ctx: CommandContext,
  deptKey: string
): Promise<Array<{ type: string; pemEncodedCertificate: string }> | undefined> {
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

  const x5Chain: Array<{ type: string; pemEncodedCertificate: string }> = [
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
      commonName: `${dept.name} Document Signer`,
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
      commonName,
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

/** Create issuer service for a department */
async function createDepartmentIssuer(
  ctx: CommandContext,
  organization: string,
  dept: DepartmentConfig,
  gov: GovServicesConfig
): Promise<void> {
  const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;
  ctx.log(`Create issuer: ${dept.name}`, 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    `Issuer ${dept.issuerName}`,
    async () => {
      const request = buildDepartmentIssuerConfig(organization, ctx.tenantPath, dept, gov);
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

        // Add x5Chain for X.509-backed credentials (mdoc and W3C JWT VC)
        if (cred.format === 'mso_mdoc' || cred.format === 'jwt_vc_json') {
          const x5Chain = await buildDepartmentMdocX5Chain(ctx, deptKey);
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

/** Load all trusted government issuers into the trust registry */
async function loadGovIssuersIntoTrustRegistry(
  ctx: CommandContext,
  organization: string,
  departments: Record<string, DepartmentConfig>,
  gov: GovServicesConfig
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

    trustedEntities.push({
      entityId,
      entityType: 'PID_PROVIDER',
      legalName: dept.name,
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
  const untrustedIacaPem = await createIacaCertificateForKey(
    ctx,
    'untrusted-iaca-cert',
    untrustedIacaKeyId,
    'Untrusted Department Test IACA'
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
        id: GOV_CREDENTIAL_IDS.employeeStatus,
        format: 'jwt_vc_json',
        profileSuffix: untrusted.credentialProfileSuffix,
        sampleData: buildEmployeeStatusCredentialData('Untrusted Department', gov.serviceBaseUrl),
        mapping: W3C_X509_MAPPING,
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

  // 4. Create untrusted issuer service
  const issuerConfig = {
    type: 'issuer2',
    _id: issuerPath,
    baseUrl: gov.serviceBaseUrl,
    tokenKeyId: untrusted.signingKeyId,
    kms: `${ctx.tenantPath}.${RESOURCES.kms}`,
    issuerDisplayConfiguration: buildIssuerDisplayConfiguration(
      ['GOV_UNTRUSTED_ISSUER', 'GOV_ISSUER'],
      'Untrusted Department Issuer',
      'Untrusted department issuer logo',
      `${gov.serviceBaseUrl}/logos/gov-untrusted-issuer.png`
    ),
    credentialConfigurations: {
      [GOV_CREDENTIAL_IDS.employeeStatus]: {
        format: 'jwt_vc_json',
        scope: GOV_CREDENTIAL_IDS.employeeStatus,
        credential_signing_alg_values_supported: ['ES256'],
        cryptographic_binding_methods_supported: ['jwk'],
        proof_types_supported: {
          jwt: { proof_signing_alg_values_supported: ['ES256'] },
        },
        credential_definition: {
          type: ['VerifiableCredential', GOV_CREDENTIAL_IDS.employeeStatus],
        },
      },
    },
  };

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
    credentialConfigurationId: GOV_CREDENTIAL_IDS.employeeStatus,
    issuerKeyId: untrusted.signingKeyId,
    credentialData: buildEmployeeStatusCredentialData('Untrusted Department', gov.serviceBaseUrl),
    mapping: W3C_X509_MAPPING,
    x5Chain: untrustedX5Chain,
    idTokenClaimsMapping: {
      '$.employeeId': '$.credentialSubject.employeeId',
      '$.department': '$.credentialSubject.department',
      '$.position': '$.credentialSubject.position',
      '$.clearanceLevel': '$.credentialSubject.clearanceLevel',
      '$.startDate': '$.credentialSubject.startDate',
    },
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
        clientId: 'untrusted-verifier',
        clientMetadata: buildVerifierClientMetadata(
          ['GOV_UNTRUSTED_VERIFIER', 'GOV_VERIFIER'],
          'Untrusted Department Verifier',
          `${gov.serviceBaseUrl}/logos/gov-untrusted-verifier.png`
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
    console.log(`   [OK] Untrusted verifier created: ${verifierPath} (no trust registry)`);
  }
}
async function createGovVerifier(
  ctx: CommandContext,
  gov: GovServicesConfig
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create central government verifier', 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Verifier service',
    async () => {
      const request = {
        type: 'verifier2',
        baseUrl: gov.serviceBaseUrl,
        clientId: 'gov-verifier',
        clientMetadata: buildVerifierClientMetadata(
          ['GOV_CENTRAL_VERIFIER', 'GOV_VERIFIER'],
          'Government Services Verifier',
          `${gov.serviceBaseUrl}/logos/gov-central-verifier.png`
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
    console.log(`   [OK] Verifier created (baseUrl: ${gov.serviceBaseUrl})`);
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
 * 8. Trust registry service (linked to verifier)
 * 9. Issuers for each department
 * 10. Credential profiles for each credential type
 * 11. All trusted issuers loaded into trust registry (DSCs)
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
  await createGovVerifier(ctx, gov);

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

  // 8. Create trust registry and link services
  await createGovTrustRegistry(ctx);
  await linkGovVerifierToTrustRegistry(ctx);

  // 9. Create issuers for each department
  for (const dept of Object.values(departments)) {
    await createDepartmentIssuer(ctx, organization, dept, gov);
  }

  // 10. Create credential profiles
  for (const [deptKey, dept] of Object.entries(departments)) {
    await createDepartmentProfiles(ctx, organization, deptKey, dept);
  }

  // 11. Load all trusted issuers into trust registry
  await loadGovIssuersIntoTrustRegistry(ctx, organization, departments, gov);

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
  console.log(`  - Verifier (no trust registry): ${organization}.${untrustedDept.tenantId}.${untrustedDept.verifierName}`);
  console.log(`\nTrust registry source ID: ${gov.trustedSourceId}`);
}
