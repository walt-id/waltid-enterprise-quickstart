/**
 * Configuration for the gov-services-tenant setup command.
 * Sets up a multi-department government services ecosystem with:
 * - Central government tenant with KMS and wallet
 * - Department tenants (HR, Identity, Revenue, Finance)
 * - Issuers for each department with various credential formats
 * - Central verifier service
 *
 * Values are loaded from cli/gov-services.env (see gov-services.env.example).
 */

import { join } from 'path';
import { loadEnvFile } from './env.js';

export interface GovServicesConfig {
  /** Public base URL for issuer and verifier services */
  serviceBaseUrl: string;
  /** Base URL for SD-JWT VCT values */
  vctBaseUrl: string;
  /** Main tenant ID (central government) */
  tenant: string;
  /** Department tenant IDs */
  departments: {
    hr: string;
    identity: string;
    revenue: string;
    finance: string;
  };
}

/** ISO 23220 Photo ID doctype */
export const PHOTO_ID_DOCTYPE = 'org.iso.23220.photoid.1';
export const PHOTO_ID_NAMESPACE = 'org.iso.23220.1';

/** Credential type IDs */
export const GOV_CREDENTIAL_IDS = {
  employeeStatus: 'EmployeeStatusCredential',
  photoId: PHOTO_ID_DOCTYPE,
  taxRegistration: 'tax_registration',
  bankAccount: 'BankAccountCredential',
  addressProof: 'AddressProofCredential',
} as const;

/** Proof type configurations */
const MDOC_PROOF_TYPES = {
  credential_signing_alg_values_supported: [-7, -9] as number[],
  cryptographic_binding_methods_supported: ['cose_key'],
  proof_types_supported: {
    jwt: { proof_signing_alg_values_supported: ['ES256'] },
  },
};

const SDJWT_PROOF_TYPES = {
  credential_signing_alg_values_supported: ['ES256'],
  cryptographic_binding_methods_supported: ['jwk'],
  proof_types_supported: {
    jwt: { proof_signing_alg_values_supported: ['ES256'] },
  },
};

const JWT_VC_PROOF_TYPES = {
  cryptographic_binding_methods_supported: ['did:key'],
  credential_signing_alg_values_supported: ['ES256'],
  proof_types_supported: {
    jwt: { proof_signing_alg_values_supported: ['ES256'] },
  },
};

function claimDisplay(name: string, locale = 'en') {
  return [{ name, locale }];
}

/** Sample tax credential payload (dc+sd-jwt) */
export const taxRegistrationDefaultValues = {
  tax_id: '123/456/78901',
  tax_number: '918273645',
  tax_assessment_year: '2024',
  annual_income: '65000',
  tax_class: 'I',
  status: 'Compliant',
  valid_until: '2025-12-31',
  given_name: 'Max',
  family_name: 'Mustermann',
  birthdate: '1985-03-15',
};

/** Sample Photo ID credential payload (mso_mdoc ISO 23220) */
export const photoIdDefaultValues = {
  [PHOTO_ID_NAMESPACE]: {
    family_name: 'Mustermann',
    given_name: 'Max',
    birth_date: '1985-03-15',
    portrait: 'base64-encoded-photo-placeholder',
    issuing_authority: 'Government Identity Services',
    issuing_country: 'DE',
    document_number: 'ID-2024-001234',
    issue_date: '2024-01-15',
    expiry_date: '2034-01-15',
    nationality: 'DE',
  },
};

/** Credential format types */
export type CredentialFormat = 'jwt_vc_json' | 'mso_mdoc' | 'dc+sd-jwt';

/** Department configuration */
export interface DepartmentConfig {
  tenantId: string;
  name: string;
  issuerName: string;
  signingKeyId: string;
  credentials: CredentialConfig[];
}

/** Check if a department has any jwt_vc_json credentials (needs DID) */
export function departmentNeedsDid(dept: DepartmentConfig): boolean {
  return dept.credentials.some(cred => cred.format === 'jwt_vc_json');
}

/** Check if a department has any mso_mdoc credentials (needs DSC) */
export function departmentNeedsDsc(dept: DepartmentConfig): boolean {
  return dept.credentials.some(cred => cred.format === 'mso_mdoc');
}

export interface CredentialConfig {
  id: string;
  format: CredentialFormat;
  profileSuffix: string;
  sampleData: Record<string, unknown>;
  doctype?: string;
  vct?: string;
  /** W3C VC version (for jwt_vc_json) */
  /** Dynamic field mapping (for jwt_vc_json) */
  mapping?: Record<string, unknown>;
}

/** W3C VC DM 2.0 context URLs */
const W3C_VC_CONTEXT = ['https://www.w3.org/2018/credentials/v1', 'https://purl.imsglobal.org/spec/ob/v3p0/context.json'];

/** Standard W3C VC mapping for dynamic fields */
const W3C_VC_MAPPING = {
  id: '<uuid>',
  issuer: {
    id: '<issuerDid>',
  },
  credentialSubject: {
    id: '<subjectDid>',
  },
  issuanceDate: '<timestamp>',
  expirationDate: '<timestamp-in:365d>',
};

/** Build W3C VC DM 2.0 credential data structure */
function buildW3cVcCredentialData(
  credentialType: string,
  issuerName: string,
  issuerUrl: string,
  subjectData: Record<string, unknown>
): Record<string, unknown> {
  return {
    '@context': W3C_VC_CONTEXT,
    id: 'urn:uuid:placeholder',
    type: ['VerifiableCredential', credentialType],
    name: credentialType.replace(/Credential$/, '').replace(/([A-Z])/g, ' $1').trim(),
    issuanceDate: '2024-01-01T00:00:00Z',
    issuer: {
      type: ['Profile'],
      name: issuerName,
      url: issuerUrl,
      id: 'did:placeholder:issuer',
    },
    credentialSubject: {
      id: 'did:placeholder:subject',
      type: ['Person'],
      ...subjectData,
    },
  };
}

/** Build department configurations from env settings */
export function buildDepartmentConfigs(
  organization: string,
  gov: GovServicesConfig
): Record<string, DepartmentConfig> {
  const mainTenantPath = `${organization}.${gov.tenant}`;
  const kmsRef = `${mainTenantPath}.kms`;

  return {
    hr: {
      tenantId: gov.departments.hr,
      name: 'Human Resources Department',
      issuerName: 'hr-issuer',
      signingKeyId: `${kmsRef}.hr-signing-key`,
      credentials: [
        {
          id: GOV_CREDENTIAL_IDS.employeeStatus,
          format: 'jwt_vc_json',
          profileSuffix: 'employee',
          mapping: { ...W3C_VC_MAPPING },
          sampleData: buildW3cVcCredentialData(
            GOV_CREDENTIAL_IDS.employeeStatus,
            'Human Resources Department',
            gov.serviceBaseUrl,
            {
              employeeId: 'EMP-2024-001',
              department: 'Central Government',
              position: 'Senior Analyst',
              clearanceLevel: 'Confidential',
              startDate: '2020-03-15',
            }
          ),
        },
      ],
    },
    identity: {
      tenantId: gov.departments.identity,
      name: 'Identity Services Department',
      issuerName: 'identity-issuer',
      signingKeyId: `${kmsRef}.identity-signing-key`,
      credentials: [
        {
          id: GOV_CREDENTIAL_IDS.photoId,
          format: 'mso_mdoc',
          doctype: PHOTO_ID_DOCTYPE,
          profileSuffix: 'photo-id',
          sampleData: { ...photoIdDefaultValues },
        },
        {
          id: GOV_CREDENTIAL_IDS.addressProof,
          format: 'jwt_vc_json',
          profileSuffix: 'address',
          mapping: { ...W3C_VC_MAPPING },
          sampleData: buildW3cVcCredentialData(
            GOV_CREDENTIAL_IDS.addressProof,
            'Identity Services Department',
            gov.serviceBaseUrl,
            {
              street: 'Musterstraße 123',
              city: 'Berlin',
              postalCode: '10115',
              country: 'DE',
            }
          ),
        },
      ],
    },
    revenue: {
      tenantId: gov.departments.revenue,
      name: 'Revenue Authority',
      issuerName: 'revenue-issuer',
      signingKeyId: `${kmsRef}.revenue-signing-key`,
      credentials: [
        {
          id: GOV_CREDENTIAL_IDS.taxRegistration,
          format: 'dc+sd-jwt',
          vct: `{vctBaseURL}/${GOV_CREDENTIAL_IDS.taxRegistration}`,
          profileSuffix: 'tax',
          sampleData: { ...taxRegistrationDefaultValues },
        },
      ],
    },
    finance: {
      tenantId: gov.departments.finance,
      name: 'Financial Services Authority',
      issuerName: 'finance-issuer',
      signingKeyId: `${kmsRef}.finance-signing-key`,
      credentials: [
        {
          id: GOV_CREDENTIAL_IDS.bankAccount,
          format: 'jwt_vc_json',
          profileSuffix: 'bank-account',
          mapping: { ...W3C_VC_MAPPING },
          sampleData: buildW3cVcCredentialData(
            GOV_CREDENTIAL_IDS.bankAccount,
            'Financial Services Authority',
            gov.serviceBaseUrl,
            {
              accountNumber: 'DE89370400440532013000',
              accountType: 'Current',
              bankName: 'Demo Bank',
              accountHolder: 'Max Mustermann',
              verifiedDate: '2024-01-15',
            }
          ),
        },
      ],
    },
  };
}

/** Load gov-services.env from the CLI directory */
export function loadGovServicesEnv(cliDir: string): void {
  loadEnvFile(join(cliDir, 'gov-services.env'), { override: true });

  const tenant = process.env.GOV_TENANT || process.env.TENANT || 'gov-central';
  process.env.TENANT = tenant;
}

export function createGovServicesConfig(): GovServicesConfig {
  const serviceBaseUrl =
    process.env.GOV_SERVICES_BASE_URL ||
    process.env.ISSUER_BASE_URL ||
    '';

  if (!serviceBaseUrl) {
    throw new Error(
      'GOV_SERVICES_BASE_URL is required. Set it in cli/gov-services.env (see gov-services.env.example).'
    );
  }

  const vctBaseUrl = process.env.GOV_VCT_BASE_URL || serviceBaseUrl.replace(/\/$/, '');

  return {
    serviceBaseUrl: serviceBaseUrl.replace(/\/$/, ''),
    vctBaseUrl: vctBaseUrl.replace(/\/$/, ''),
    tenant: process.env.GOV_TENANT || process.env.TENANT || 'gov-central',
    departments: {
      hr: process.env.GOV_DEPT_HR || 'dept-hr',
      identity: process.env.GOV_DEPT_IDENTITY || 'dept-identity',
      revenue: process.env.GOV_DEPT_REVENUE || 'dept-revenue',
      finance: process.env.GOV_DEPT_FINANCE || 'dept-finance',
    },
  };
}

/** Build credential configuration for issuer service based on format */
function buildCredentialConfiguration(
  cred: CredentialConfig
): Record<string, unknown> {
  if (cred.format === 'mso_mdoc') {
    return {
      format: 'mso_mdoc',
      scope: cred.id,
      doctype: cred.doctype || cred.id,
      ...MDOC_PROOF_TYPES,
      credential_metadata: {
        display: [{ name: `Photo ID (ISO 23220)`, locale: 'en' }],
        claims: [
          { path: [PHOTO_ID_NAMESPACE, 'family_name'], mandatory: true, display: claimDisplay('Family Name') },
          { path: [PHOTO_ID_NAMESPACE, 'given_name'], mandatory: true, display: claimDisplay('Given Name') },
          { path: [PHOTO_ID_NAMESPACE, 'birth_date'], mandatory: true, display: claimDisplay('Birth Date') },
          { path: [PHOTO_ID_NAMESPACE, 'portrait'], mandatory: false, display: claimDisplay('Portrait') },
          { path: [PHOTO_ID_NAMESPACE, 'document_number'], mandatory: true, display: claimDisplay('Document Number') },
          { path: [PHOTO_ID_NAMESPACE, 'issue_date'], mandatory: true, display: claimDisplay('Issue Date') },
          { path: [PHOTO_ID_NAMESPACE, 'expiry_date'], mandatory: true, display: claimDisplay('Expiry Date') },
          { path: [PHOTO_ID_NAMESPACE, 'issuing_authority'], mandatory: true, display: claimDisplay('Issuing Authority') },
          { path: [PHOTO_ID_NAMESPACE, 'issuing_country'], mandatory: true, display: claimDisplay('Issuing Country') },
          { path: [PHOTO_ID_NAMESPACE, 'nationality'], mandatory: true, display: claimDisplay('Nationality') },
        ],
      },
    };
  }

  if (cred.format === 'dc+sd-jwt') {
    return {
      format: 'dc+sd-jwt',
      scope: cred.id,
      vct: cred.vct,
      ...SDJWT_PROOF_TYPES,
      credential_metadata: {
        display: [{ name: 'Tax Registration Credential', locale: 'en' }],
        claims: [
          { path: ['tax_id'], mandatory: true, display: claimDisplay('Tax ID') },
          { path: ['tax_number'], mandatory: true, display: claimDisplay('Tax Number') },
          { path: ['tax_assessment_year'], mandatory: true, display: claimDisplay('Assessment Year') },
          { path: ['annual_income'], mandatory: false, display: claimDisplay('Annual Income') },
          { path: ['tax_class'], mandatory: true, display: claimDisplay('Tax Class') },
          { path: ['status'], mandatory: true, display: claimDisplay('Status') },
          { path: ['valid_until'], mandatory: true, display: claimDisplay('Valid Until') },
          { path: ['given_name'], mandatory: true, display: claimDisplay('Given Name') },
          { path: ['family_name'], mandatory: true, display: claimDisplay('Family Name') },
          { path: ['birthdate'], mandatory: false, display: claimDisplay('Birth Date') },
        ],
      },
    };
  }

  // jwt_vc_json format
  return {
    format: 'jwt_vc_json',
    scope: cred.id,
    ...JWT_VC_PROOF_TYPES,
    credential_definition: {
      type: ['VerifiableCredential', cred.id],
    },
  };
}

/** Build issuer2 service configuration for a department */
export function buildDepartmentIssuerConfig(
  organization: string,
  mainTenantPath: string,
  dept: DepartmentConfig,
  gov: GovServicesConfig
): Record<string, unknown> {
  const issuerPath = `${organization}.${dept.tenantId}.${dept.issuerName}`;
  const kmsRef = `${mainTenantPath}.kms`;

  const credentialConfigurations: Record<string, unknown> = {};
  const sdJwtVcTypeMetadata: Record<string, unknown> = {};

  for (const cred of dept.credentials) {
    credentialConfigurations[cred.id] = buildCredentialConfiguration(cred);

    if (cred.format === 'dc+sd-jwt') {
      sdJwtVcTypeMetadata[cred.id] = {
        name: 'Tax Registration Credential',
        description: 'Government tax registration and compliance attestation.',
      };
    }
  }

  const config: Record<string, unknown> = {
    type: 'issuer2',
    _id: issuerPath,
    baseUrl: gov.serviceBaseUrl,
    tokenKeyId: dept.signingKeyId,
    kms: kmsRef,
    credentialConfigurations,
  };

  if (Object.keys(sdJwtVcTypeMetadata).length > 0) {
    config.sdJwtVcTypeMetadataConfiguration = sdJwtVcTypeMetadata;
  }

  return config;
}
