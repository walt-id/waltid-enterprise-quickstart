/**
 * Government services tenant setup: a multi-department ecosystem with:
 * - Central government tenant (KMS, wallet, verifier)
 * - DID service and DID store for issuer DIDs (jwt_vc_json credentials)
 * - Department tenants (HR, Identity, Revenue, Finance)
 * - Issuers for each department with various credential formats
 * - Credential profiles for each credential type
 *
 * Configuration is loaded from cli/gov-services.env (see gov-services.env.example).
 */

import { CommandContext } from '../../context.js';
import { RESOURCES, CERT_IDS, KEY_IDS } from '../../config.js';
import {
  GovServicesConfig,
  DepartmentConfig,
  CredentialConfig,
  buildDepartmentConfigs,
  buildDepartmentIssuerConfig,
  departmentNeedsDid,
  departmentNeedsDsc,
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

/** Map of department key to their DID (for jwt_vc_json issuers) */
const departmentDids: Map<string, string> = new Map();

/** Map of department key to their DSC PEM (for mso_mdoc issuers) */
const departmentDscPems: Map<string, string> = new Map();

/** Build x5c chain for mso_mdoc profiles using department's DSC */
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
  dept: DepartmentConfig
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

  // Ensure we have IACA PEM
  if (!ctx.ctx.iacaPem) {
    try {
      const certResponse = await ctx.orgClient.get(
        `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${CERT_IDS.vicalIacaCert}/x509-store-api/certificates`
      );
      ctx.ctx.iacaPem = certResponse.data.data?.pem || certResponse.data.certificatePem || certResponse.data.pem;
    } catch {
      throw new Error('IACA certificate not found. Ensure IACA is created before department DSCs.');
    }
  }

  const request = {
    storedCertificateId: dscCertId,
    iacaSigner: {
      type: 'iaca-pem-cert-descriptor',
      iacaPemEncodedCertificate: ctx.ctx.iacaPem,
      iacaKeyDesc: {
        type: 'kms-hosted-key-descriptor',
        keyIdPath: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.vicalIacaKey}`,
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

/** Create DID service and DID store for issuer DIDs */
async function createDidServices(ctx: CommandContext): Promise<void> {
  ctx.log('Create DID service and DID store', 'GOV-SETUP');

  // Create DID store
  const { created: storeCreated } = await ctx.tolerantCreate(
    'DID store',
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.didStore}/resource-api/services/create`,
        { type: 'did-store' }
      );
      return response;
    }
  );

  if (storeCreated) {
    console.log(`   [OK] DID store created: ${ctx.tenantPath}.${RESOURCES.didStore}`);
  }

  // Create DID service
  const { created: serviceCreated } = await ctx.tolerantCreate(
    'DID service',
    async () => {
      const response = await ctx.orgClient.post(
        `/v1/${ctx.tenantPath}.${RESOURCES.didService}/resource-api/services/create`,
        { type: 'did' }
      );
      return response;
    }
  );

  if (serviceCreated) {
    console.log(`   [OK] DID service created: ${ctx.tenantPath}.${RESOURCES.didService}`);
  }
}

/** Link DID service dependencies (KMS and DID store) */
async function linkDidServiceDependencies(ctx: CommandContext): Promise<void> {
  ctx.log('Link DID service dependencies', 'GOV-SETUP');

  // Link KMS to DID service
  try {
    await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.didService}/did-service-api/dids/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.kms}`,
      'text/plain'
    );
    console.log(`   [OK] Linked KMS to DID service`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] KMS already linked to DID service`);
    } else {
      throw error;
    }
  }

  // Link DID store to DID service
  try {
    await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${RESOURCES.didService}/did-service-api/dids/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.didStore}`,
      'text/plain'
    );
    console.log(`   [OK] Linked DID store to DID service`);
  } catch (error: any) {
    if (error.status === 409 || error.message?.includes('already')) {
      console.log(`   [SKIP] DID store already linked to DID service`);
    } else {
      throw error;
    }
  }
}

/** Create a DID for a department's issuer using their signing key */
async function createDepartmentDid(
  ctx: CommandContext,
  deptKey: string,
  dept: DepartmentConfig
): Promise<string> {
  ctx.log(`Create DID for ${dept.name}`, 'GOV-SETUP');

  // Create did:key using the department's signing key
  const createResponse = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.didService}/did-service-api/dids/create/key`,
    {
      keyId: dept.signingKeyId,
    }
  );

  const createdDid =
    createResponse.data?.did ||
    createResponse.data?.data?.did ||
    createResponse.data?.id ||
    createResponse.data;

  console.log(`   [OK] DID created for ${dept.name}: ${createdDid}`);
  
  // Store the DID for later use in profile creation
  departmentDids.set(deptKey, createdDid);
  
  return createdDid;
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
  const issuerDid = departmentDids.get(deptKey);

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
          if (issuerDid) {
            request.issuerDid = issuerDid;
          }
          if (cred.mapping) {
            request.mapping = cred.mapping;
          }
        }

        // Add x5cChain for mso_mdoc credentials (using department's DSC)
        if (cred.format === 'mso_mdoc') {
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

/** Create central verifier service */
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
  ctx.log('Initialize central government wallet', 'GOV-SETUP');

  const { created } = await ctx.tolerantCreate(
    'Wallet',
    async () => {
      const request = {
        createKeyInKms: {
          keyType: 'secp256r1',
        },
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

  ctx.ctx.walletKeyRef = `${ctx.tenantPath}.${RESOURCES.kms}.wallet_key`;

  if (created) {
    console.log(`   [OK] Wallet initialized`);
  }
}

/**
 * Run full government services tenant setup.
 *
 * Creates:
 * 1. Central government tenant with KMS and wallet
 * 2. DID service and DID store (for W3C credential issuers)
 * 3. X.509 services and IACA certificate (for mdoc credentials)
 * 4. Department tenants (HR, Identity, Revenue, Finance)
 * 5. Signing keys for each department (in central KMS)
 * 6. DIDs for departments with jwt_vc_json credentials (using their signing key)
 * 7. DSCs for departments with mso_mdoc credentials (using their signing key)
 * 8. Issuers for each department
 * 9. Credential profiles for each credential type
 * 10. Central verifier service
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
  console.log(`Departments: ${Object.values(gov.departments).join(', ')}\n`);

  const organization = ctx.config.organization;
  const departments = buildDepartmentConfigs(organization, gov);

  // Clear any previous mappings
  departmentDids.clear();
  departmentDscPems.clear();

  await setupLogin(ctx);

  // 1. Create central government tenant and core services
  await setupCreateTenant(ctx);
  await setupCreateServices(ctx);
  await setupLinkX509Dependencies(ctx);
  await createGovWallet(ctx);
  await createGovVerifier(ctx, gov);

  // 2. Create DID service and DID store (needed for W3C jwt_vc_json credentials)
  await createDidServices(ctx);
  await linkDidServiceDependencies(ctx);

  // 3. Import keys and create IACA certificate (needed for mdoc DSCs)
  await setupImportKeys(ctx);
  await setupCreateIacaCertificate(ctx);

  // 4. Create department tenants
  for (const dept of Object.values(departments)) {
    await createDepartmentTenant(ctx, organization, dept);
  }

  // 5. Create signing keys for each department (in central KMS)
  for (const dept of Object.values(departments)) {
    await createDepartmentSigningKey(ctx, dept);
  }

  // 6. Create DIDs for departments that have jwt_vc_json credentials
  for (const [deptKey, dept] of Object.entries(departments)) {
    if (departmentNeedsDid(dept)) {
      await createDepartmentDid(ctx, deptKey, dept);
    }
  }

  // 7. Create DSCs for departments that have mso_mdoc credentials
  for (const [deptKey, dept] of Object.entries(departments)) {
    if (departmentNeedsDsc(dept)) {
      await createDepartmentDsc(ctx, deptKey, dept);
    }
  }

  // 8. Create issuers for each department
  for (const dept of Object.values(departments)) {
    await createDepartmentIssuer(ctx, organization, dept, gov);
  }

  // 9. Create credential profiles
  for (const [deptKey, dept] of Object.entries(departments)) {
    await createDepartmentProfiles(ctx, organization, deptKey, dept);
  }

  console.log('\n[GOV-SETUP] Government services tenant setup completed');
  console.log('\nCreated issuers:');
  for (const [deptKey, dept] of Object.entries(departments)) {
    const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;
    const did = departmentDids.get(deptKey);
    const hasDsc = departmentDscPems.has(deptKey);
    console.log(`  - ${dept.name}: ${issuerPath}`);
    if (did) {
      console.log(`      DID: ${did}`);
    }
    if (hasDsc) {
      console.log(`      DSC: ${deptKey}-dsc`);
    }
    for (const cred of dept.credentials) {
      console.log(`      Profile: ${issuerPath}.${cred.profileSuffix} (${cred.id}, ${cred.format})`);
    }
  }
}
