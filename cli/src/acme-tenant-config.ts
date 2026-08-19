/**
 * Configuration for the acme-tenant setup command.
 * Values are loaded from cli/acme-tenant.env (see acme-tenant.env.example).
 */

import { join } from 'path';
import { loadEnvFile } from './env.js';

export interface AcmeTenantConfig {
  /** Public base URL used by issuer and verifier services */
  serviceBaseUrl: string;
  /** Base URL for VCT values */
  vctBaseUrl: string;
  tenant: string;
  keycloak: {
    authorizeUrl: string;
    accessTokenUrl: string;
    clientId: string;
    clientSecret: string;
    defaultScopes: string[];
  };
  openId: {
    issuerDisplayConfiguration: IssuerDisplayConfiguration[];
    verifierClientMetadata: VerifierClientMetadata;
  };
}

export interface IssuerDisplayConfiguration {
  name: string;
  locale: string;
  logo?: {
    uri: string;
    alt_text: string;
  };
}

export interface VerifierClientMetadata {
  client_name: string;
  logo_uri?: string;
}

const DEFAULT_SCOPES = ['openid', 'profile'];

const PHOTO_ID_NAMESPACE = 'org.iso.23220.photoid.1';
const EMPLOYEE_CREDENTIAL_ID = 'employee_credential';

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

/** Sample employee credential payload (mDoc) */
export const employeePhotoIdDefaultValues = {
  given_name: 'Jane',
  family_name: 'Smith',
  date_of_birth: '1990-05-15',
  employee_id: 'EMP-50234',
  issue_date: '2024-08-13',
  expiry_date: '2029-08-13',
  idv_complete: 'true',
};

function claimDisplay(name: string, locale = 'en') {
  return [{ name, locale }];
}

function buildIssuerDisplayConfiguration(serviceBaseUrl: string): IssuerDisplayConfiguration[] {
  const logoUri = process.env.ACME_ISSUER_DISPLAY_LOGO_URI || `${serviceBaseUrl}/logo.png`;

  return [
    {
      name: process.env.ACME_ISSUER_DISPLAY_NAME || 'Acme Credential Issuer',
      locale: process.env.ACME_ISSUER_DISPLAY_LOCALE || 'en-US',
      logo: {
        uri: logoUri,
        alt_text: process.env.ACME_ISSUER_DISPLAY_LOGO_ALT_TEXT || 'Acme issuer logo',
      },
    },
  ];
}

function buildVerifierClientMetadata(serviceBaseUrl: string): VerifierClientMetadata {
  const clientMetadata: VerifierClientMetadata = {
    client_name: process.env.ACME_VERIFIER_CLIENT_NAME || 'Acme Credential Verifier',
  };

  const logoUri = process.env.ACME_VERIFIER_LOGO_URI || `${serviceBaseUrl}/logo.png`;
  if (logoUri) {
    clientMetadata.logo_uri = logoUri;
  }

  return clientMetadata;
}

/** Credential type definition for acme-tenant issuer profiles */
export interface CredentialTypeConfig {
  id: string;
  name: string;
  format: 'mso_mdoc' | 'dc+sd-jwt';
  credentialConfigurationId: string;
  /** Suffix appended to issuer target for profile service ref (e.g. photo-id → issuer2.photo-id) */
  profileSuffix: string;
  sampleCredentialData: Record<string, unknown>;
  doctype?: string;
  vct?: string;
}

/** Credential types configured on the acme-tenant issuer */
export const ACME_CREDENTIAL_TYPES: Record<string, CredentialTypeConfig> = {
  photoId: {
    id: PHOTO_ID_NAMESPACE,
    name: 'Employee Photo ID (mDoc)',
    format: 'mso_mdoc',
    doctype: PHOTO_ID_NAMESPACE,
    credentialConfigurationId: PHOTO_ID_NAMESPACE,
    profileSuffix: 'photo-id',
    sampleCredentialData: {
      [PHOTO_ID_NAMESPACE]: {
        given_name: 'Jane',
        family_name: 'Smith',
        date_of_birth: '1990-05-15',
        employee_id: 'EMP-50234',
        issue_date: '2024-08-13',
        expiry_date: '2029-08-13',
        idv_complete: 'true',
      },
    },
  },
  employee: {
    id: EMPLOYEE_CREDENTIAL_ID,
    name: 'Employee Credential (SD-JWT)',
    format: 'dc+sd-jwt',
    credentialConfigurationId: EMPLOYEE_CREDENTIAL_ID,
    profileSuffix: 'employee',
    sampleCredentialData: {
      given_name: 'Jane',
      family_name: 'Smith',
      date_of_birth: '1990-05-15',
      employee_id: 'EMP-50234',
      department: 'Engineering',
      job_title: 'Senior Software Engineer',
      employment_start_date: '2020-01-15',
      email: 'jane.smith@acme.com',
      phone_number: '+1-555-0123',
      office_location: 'New York, NY',
    },
  },
};

/** Keys of credential types that have issuer credentialConfigurations */
export const ACME_ISSUER_CREDENTIAL_TYPE_KEYS = [
  'photoId',
  'employee',
] as const;

/** Issuer service reference: {org}.{tenant}.issuer2 */
export function buildIssuerTarget(tenantPath: string, issuerService = 'issuer2'): string {
  return `${tenantPath}.${issuerService}`;
}

/** Profile service ref: issuer target + suffix (e.g. …issuer2.photo-id) */
export function buildProfileId(issuerTarget: string, suffix: string): string {
  return `${issuerTarget}.${suffix}`;
}

/** Load acme-tenant.env from the CLI directory into process.env. */
export function loadAcmeTenantEnv(cliDir: string): void {
  loadEnvFile(join(cliDir, 'acme-tenant.env'), { override: true });

  const tenant = process.env.ACME_TENANT || process.env.TENANT || 'acme-tenant';
  process.env.TENANT = tenant;
}

export function createAcmeTenantConfig(): AcmeTenantConfig {
  const serviceBaseUrl =
    process.env.ACME_TENANT_BASE_URL ||
    process.env.ISSUER_BASE_URL ||
    '';

  if (!serviceBaseUrl) {
    throw new Error(
      'ACME_TENANT_BASE_URL is required. Set it in cli/acme-tenant.env (see acme-tenant.env.example).'
    );
  }

  const vctBaseUrl = process.env.VCT_BASE_URL || serviceBaseUrl.replace(/\/$/, '');

  const scopesRaw = process.env.KEYCLOAK_DEFAULT_SCOPES || 'openid,profile';
  const defaultScopes = scopesRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    serviceBaseUrl: serviceBaseUrl.replace(/\/$/, ''),
    vctBaseUrl: vctBaseUrl.replace(/\/$/, ''),
    tenant: process.env.ACME_TENANT || process.env.TENANT || 'acme-tenant',
    keycloak: {
      authorizeUrl: process.env.KEYCLOAK_AUTHORIZE_URL || '',
      accessTokenUrl: process.env.KEYCLOAK_ACCESS_TOKEN_URL || '',
      clientId: process.env.KEYCLOAK_CLIENT_ID || 'issuer_api',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
      defaultScopes: defaultScopes.length > 0 ? defaultScopes : DEFAULT_SCOPES,
    },
    openId: {
      issuerDisplayConfiguration: buildIssuerDisplayConfiguration(serviceBaseUrl.replace(/\/$/, '')),
      verifierClientMetadata: buildVerifierClientMetadata(serviceBaseUrl.replace(/\/$/, '')),
    },
  };
}

/**
 * Build issuer2 service configuration for the acme tenant.
 * KMS is referenced in the create body (tokenKeyId, kms) — not via dependencies/add.
 */
export function buildAcmeIssuerServiceConfig(
  tenantPath: string,
  acme: AcmeTenantConfig,
  attesterPublicJwk?: any,
): Record<string, unknown> {
  const kmsService = 'kms';
  const issuerSigningKey = 'issuer-signing-key';
  const kmsRef = `${tenantPath}.${kmsService}`;
  const tokenKeyId = `${kmsRef}.${issuerSigningKey}`;

  let config: any = {
    type: 'issuer2',
    _id: `${tenantPath}.issuer2`,
    baseUrl: acme.serviceBaseUrl,
    tokenKeyId,
    kms: kmsRef,
    credentialConfigurations: {
      [PHOTO_ID_NAMESPACE]: {
        format: 'mso_mdoc',
        scope: PHOTO_ID_NAMESPACE,
        doctype: PHOTO_ID_NAMESPACE,
        ...MDOC_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'Employee Photo ID (mDoc)', locale: 'en' },
            { name: 'Mitarbeiter Foto-ID (mDoc)', locale: 'de' },
          ],
          claims: [
            {
              path: [PHOTO_ID_NAMESPACE, 'given_name'],
              mandatory: true,
              display: claimDisplay('Given Name'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'family_name'],
              mandatory: true,
              display: claimDisplay('Family Name'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'date_of_birth'],
              mandatory: true,
              display: claimDisplay('Date of Birth'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'employee_id'],
              mandatory: true,
              display: claimDisplay('Employee ID'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'issue_date'],
              mandatory: true,
              display: claimDisplay('Issue Date'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'expiry_date'],
              mandatory: true,
              display: claimDisplay('Expiry Date'),
            },
            {
              path: [PHOTO_ID_NAMESPACE, 'idv_complete'],
              mandatory: true,
              display: claimDisplay('Identity Verification Complete'),
            },
          ],
        },
      },
      [EMPLOYEE_CREDENTIAL_ID]: {
        format: 'dc+sd-jwt',
        scope: EMPLOYEE_CREDENTIAL_ID,
        vct: `${acme.vctBaseUrl}/${EMPLOYEE_CREDENTIAL_ID}`,
        ...SDJWT_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'Employee Credential', locale: 'en' },
            { name: 'Mitarbeiterzertifikat', locale: 'de' },
          ],
          claims: [
            { path: ['given_name'], mandatory: true, display: claimDisplay('Given Name') },
            { path: ['family_name'], mandatory: true, display: claimDisplay('Family Name') },
            { path: ['date_of_birth'], mandatory: true, display: claimDisplay('Date of Birth') },
            { path: ['employee_id'], mandatory: true, display: claimDisplay('Employee ID') },
            { path: ['department'], mandatory: true, display: claimDisplay('Department') },
            { path: ['job_title'], mandatory: true, display: claimDisplay('Job Title') },
            { path: ['employment_start_date'], mandatory: true, display: claimDisplay('Employment Start Date') },
            { path: ['email'], mandatory: true, display: claimDisplay('Email Address') },
            { path: ['phone_number'], mandatory: false, display: claimDisplay('Phone Number') },
            { path: ['office_location'], mandatory: false, display: claimDisplay('Office Location') },
          ],
        },
      },
    },
    issuerDisplayConfiguration: acme.openId.issuerDisplayConfiguration,
    authProviderConfiguration: {
      name: 'Keycloak',
      authorizeUrl: acme.keycloak.authorizeUrl,
      accessTokenUrl: acme.keycloak.accessTokenUrl,
      clientId: acme.keycloak.clientId,
      clientSecret: acme.keycloak.clientSecret,
      defaultScopes: acme.keycloak.defaultScopes,
      forwardIssuerStateToAuthorizationServer: false,
    },
    sdJwtVcTypeMetadataConfiguration: {
      [EMPLOYEE_CREDENTIAL_ID]: {
        name: 'Employee Credential',
        description: 'Acme employee identification and employment attestation.',
      },
    },
  };

  if (attesterPublicJwk !== undefined) {
    config.clientAuthenticationConfig = {
      supportedMethods: [
        {
          type: 'client-attestation',
          config: {
            verificationMethod: {
              type: 'static-jwk',
              jwk: attesterPublicJwk,
            },
          },
        },
      ],
    };
  }

  return config;
}

/**
 * Build verifier2 service configuration for the acme tenant.
 */
export function buildAcmeVerifierServiceConfig(
  tenantPath: string,
  acme: AcmeTenantConfig,
): Record<string, unknown> {
  return {
    type: 'verifier2',
    _id: `${tenantPath}.verifier2`,
    baseUrl: acme.serviceBaseUrl,
    clientMetadata: acme.openId.verifierClientMetadata,
  };
}
