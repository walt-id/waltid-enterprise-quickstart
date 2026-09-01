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
    name: 'Employee Photo ID JPMC (mDoc)',
    format: 'mso_mdoc',
    doctype: PHOTO_ID_NAMESPACE,
    credentialConfigurationId: PHOTO_ID_NAMESPACE,
    profileSuffix: 'photo-id',
    sampleCredentialData: {
      [PHOTO_ID_NAMESPACE]: {
        portrait : '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',
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
            { name: 'Employee Photo ID JPMC (mDoc)', locale: 'en' },
            { name: 'Mitarbeiter Foto-ID (mDoc)', locale: 'de' },
          ],
          claims: [
            {
              path : [PHOTO_ID_NAMESPACE, 'portrait'],
              
              
            },
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
