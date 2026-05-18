/**
 * Configuration for the bank-tenant setup command.
 * Values are loaded from cli/bank-tenant.env (see bank-tenant.env.example).
 */

import { join } from 'path';
import { loadEnvFile } from './env.js';
import { RESOURCES, KEY_IDS, MDL_DOC_TYPE } from './config.js';

export interface BankTenantConfig {
  /** Public base URL used by issuer and verifier services */
  serviceBaseUrl: string;
  /** Base URL for SD-JWT VCT values (payment_account) */
  vctBaseUrl: string;
  tenant: string;
  keycloak: {
    authorizeUrl: string;
    accessTokenUrl: string;
    clientId: string;
    clientSecret: string;
    defaultScopes: string[];
  };
}

const DEFAULT_SCOPES = ['openid', 'profile'];

const PID_NAMESPACE = 'eu.europa.ec.eudi.pid.1';
const MDL_NAMESPACE = 'org.iso.18013.5.1';
const TAX_CREDENTIAL_ID = 'tax_credential';
const PAYMENT_SCA_ID = 'payment_account';

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

/** Sample tax credential payload (dc+sd-jwt) */
export const taxCredentialDefaultValues = {
  tax_id: '12345678901',
  tax_number: '918273645',
  tax_assessment_year: '2024',
  annual_income: '65000',
  tax_class: 'I',
  employer_name: 'Muster GmbH',
  employment_start_date: '2020-03-01',
  given_name: 'Max',
  family_name: 'Mustermann',
  email: 'max.mustermann@example.com',
  phone_number: '+49-30-12345678',
  address: {
    street_address: 'Musterstraße 123',
    locality: 'Berlin',
    region: 'Berlin',
    country: 'DE',
  },
  birthdate: '1985-03-15',
  is_over_18: true,
  is_over_21: true,
  is_over_65: false,
};

function claimDisplay(name: string, locale = 'en') {
  return [{ name, locale }];
}

function buildVctUrl(bank: BankTenantConfig, credentialId: string): string {
  return `{vctBaseURL}/${credentialId}`;
}

/** Credential type definition for bank-tenant issuer profiles */
export interface CredentialTypeConfig {
  id: string;
  name: string;
  format: 'mso_mdoc' | 'dc+sd-jwt';
  credentialConfigurationId: string;
  /** Suffix appended to issuer target for profile service ref (e.g. pid → issuer2.pid) */
  profileSuffix: string;
  sampleCredentialData: Record<string, unknown>;
  doctype?: string;
  vct?: string;
}

/** Credential types configured on the bank-tenant issuer */
export const BANK_CREDENTIAL_TYPES: Record<string, CredentialTypeConfig> = {
  pid: {
    id: PID_NAMESPACE,
    name: 'Person Identification Data (PID)',
    format: 'mso_mdoc',
    doctype: PID_NAMESPACE,
    credentialConfigurationId: PID_NAMESPACE,
    profileSuffix: 'pid',
    sampleCredentialData: {
      [PID_NAMESPACE]: {
        family_name: 'Mustermann',
        given_name: 'Max',
        birth_date: '1990-01-01',
        nationality: 'DE',
        expiry_date: '2035-01-01',
        issuing_authority: 'Demo Issuing Authority',
        issuing_country: 'DE',
      },
    },
  },
  mdl: {
    id: MDL_DOC_TYPE,
    name: 'Mobile Driving Licence (MDL)',
    format: 'mso_mdoc',
    doctype: MDL_DOC_TYPE,
    credentialConfigurationId: MDL_DOC_TYPE,
    profileSuffix: 'mdl',
    sampleCredentialData: {
      [MDL_NAMESPACE]: {
        family_name: 'Mustermann',
        given_name: 'Max',
        birth_date: '1985-03-15',
        issue_date: '2024-01-01',
        expiry_date: '2034-01-01',
        issuing_country: 'DE',
        issuing_authority: 'Demo Führerscheinstelle',
        document_number: 'B071234567890',
        un_distinguishing_sign: 'D',
      },
    },
  },
  tax: {
    id: TAX_CREDENTIAL_ID,
    name: 'German Tax Credential',
    format: 'dc+sd-jwt',
    credentialConfigurationId: TAX_CREDENTIAL_ID,
    profileSuffix: 'tax',
    sampleCredentialData: { ...taxCredentialDefaultValues },
  },
  sca: {
    id: PAYMENT_SCA_ID,
    name: 'Payment Account (SCA)',
    format: 'dc+sd-jwt',
    credentialConfigurationId: PAYMENT_SCA_ID,
    profileSuffix: 'sca',
    sampleCredentialData: {
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      currency: 'EUR',
      category: 'personal',
    },
  },
};

/** Keys of credential types that have issuer credentialConfigurations */
export const BANK_ISSUER_CREDENTIAL_TYPE_KEYS = [
  'pid',
  'mdl',
  'tax',
  'sca',
] as const;

/** Issuer service reference: {org}.{tenant}.issuer2 */
export function buildIssuerTarget(tenantPath: string): string {
  return `${tenantPath}.${RESOURCES.issuer}`;
}

/** Profile service ref: issuer target + suffix (e.g. …issuer2.pid) */
export function buildProfileId(issuerTarget: string, suffix: string): string {
  return `${issuerTarget}.${suffix}`;
}

/**
 * Load bank-tenant.env from the CLI directory, then read bank-tenant settings.
 */
export function loadBankTenantEnv(cliDir: string): void {
  loadEnvFile(join(cliDir, 'bank-tenant.env'), { override: true });

  const tenant = process.env.BANK_TENANT || process.env.TENANT || 'bank-tenant';
  process.env.TENANT = tenant;
}

export function createBankTenantConfig(): BankTenantConfig {
  const serviceBaseUrl =
    process.env.BANK_TENANT_BASE_URL ||
    process.env.ISSUER_BASE_URL ||
    '';

  if (!serviceBaseUrl) {
    throw new Error(
      'BANK_TENANT_BASE_URL is required. Set it in cli/bank-tenant.env (see bank-tenant.env.example).'
    );
  }

  const vctBaseUrl = process.env.VCT_BASE_URL || serviceBaseUrl.replace(/\/$/, '');

  const scopesRaw = process.env.KEYCLOAK_DEFAULT_SCOPES || 'openid,profile';
  const defaultScopes = scopesRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    serviceBaseUrl: serviceBaseUrl.replace(/\/$/, ''),
    vctBaseUrl: vctBaseUrl.replace(/\/$/, ''),
    tenant: process.env.BANK_TENANT || process.env.TENANT || 'bank-tenant',
    keycloak: {
      authorizeUrl: process.env.KEYCLOAK_AUTHORIZE_URL || '',
      accessTokenUrl: process.env.KEYCLOAK_ACCESS_TOKEN_URL || '',
      clientId: process.env.KEYCLOAK_CLIENT_ID || 'issuer_api',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
      defaultScopes: defaultScopes.length > 0 ? defaultScopes : DEFAULT_SCOPES,
    },
  };
}

/**
 * Build issuer2 service configuration for the bank tenant.
 * KMS is referenced in the create body (tokenKeyId, kms) — not via dependencies/add.
 */
export function buildBankIssuerServiceConfig(
  tenantPath: string,
  bank: BankTenantConfig,
  attesterPublicJwk: any,
): Record<string, unknown> {
  const kmsRef = `${tenantPath}.${RESOURCES.kms}`;
  const tokenKeyId = `${kmsRef}.${KEY_IDS.issuerSigningKey}`;


  return {
    type: 'issuer2',
    _id: `${tenantPath}.${RESOURCES.issuer}`,
    baseUrl: bank.serviceBaseUrl,
    tokenKeyId,
    kms: kmsRef,
    credentialConfigurations: {
      [PID_NAMESPACE]: {
        format: 'mso_mdoc',
        scope: PID_NAMESPACE,
        doctype: PID_NAMESPACE,
        ...MDOC_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'PID (MSO MDoc)', locale: 'en' },
            { name: 'Personalausweis (MSO MDoc)', locale: 'de' },
          ],
          claims: [
            {
              path: ['eu.europa.ec.eudi.pid.1', 'family_name'],
              mandatory: true,
              display: [{ name: 'Family Name(s)', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'given_name'],
              mandatory: true,
              display: [{ name: 'Given Name(s)', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'birth_date'],
              mandatory: true,
              display: [{ name: 'Birth Date', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'nationality'],
              mandatory: true,
              display: [{ name: 'Nationality', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'expiry_date'],
              mandatory: true,
              display: [{ name: 'Expiry Date', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'issuing_authority'],
              mandatory: true,
              display: [{ name: 'Issuing Authority', locale: 'en' }],
            },
            {
              path: ['eu.europa.ec.eudi.pid.1', 'issuing_country'],
              mandatory: true,
              display: [{ name: 'Issuing Country', locale: 'en' }],
            },
          ],
        },
      },
      [MDL_DOC_TYPE]: {
        format: 'mso_mdoc',
        scope: MDL_DOC_TYPE,
        doctype: MDL_DOC_TYPE,
        ...MDOC_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'Mobile Driving Licence (MDL)', locale: 'en' },
            { name: 'Mobiler Führerschein (MDL)', locale: 'de' },
          ],
          claims: [
            {
              path: [MDL_NAMESPACE, 'family_name'],
              mandatory: true,
              display: claimDisplay('Family Name'),
            },
            {
              path: [MDL_NAMESPACE, 'given_name'],
              mandatory: true,
              display: claimDisplay('Given Name'),
            },
            {
              path: [MDL_NAMESPACE, 'birth_date'],
              mandatory: true,
              display: claimDisplay('Birth Date'),
            },
            {
              path: [MDL_NAMESPACE, 'issue_date'],
              mandatory: true,
              display: claimDisplay('Issue Date'),
            },
            {
              path: [MDL_NAMESPACE, 'expiry_date'],
              mandatory: true,
              display: claimDisplay('Expiry Date'),
            },
            {
              path: [MDL_NAMESPACE, 'issuing_country'],
              mandatory: true,
              display: claimDisplay('Issuing Country'),
            },
            {
              path: [MDL_NAMESPACE, 'issuing_authority'],
              mandatory: true,
              display: claimDisplay('Issuing Authority'),
            },
            {
              path: [MDL_NAMESPACE, 'document_number'],
              mandatory: true,
              display: claimDisplay('Document Number'),
            },
          ],
        },
      },
      [TAX_CREDENTIAL_ID]: {
        format: 'dc+sd-jwt',
        scope: TAX_CREDENTIAL_ID,
        vct: buildVctUrl(bank, TAX_CREDENTIAL_ID),
        ...SDJWT_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'German Tax Credential', locale: 'en' },
            { name: 'Steuerbescheinigung', locale: 'de' },
          ],
          claims: [
            { path: ['tax_id'], mandatory: true, display: claimDisplay('Steuer-ID', 'de') },
            { path: ['tax_number'], mandatory: true, display: claimDisplay('Steuernummer', 'de') },
            { path: ['tax_assessment_year'], mandatory: true, display: claimDisplay('Veranlagungsjahr', 'de') },
            { path: ['annual_income'], mandatory: true, display: claimDisplay('Jahreseinkommen', 'de') },
            { path: ['tax_class'], mandatory: true, display: claimDisplay('Steuerklasse', 'de') },
            { path: ['employer_name'], mandatory: true, display: claimDisplay('Arbeitgeber', 'de') },
            { path: ['employment_start_date'], mandatory: true, display: claimDisplay('Beschäftigt seit', 'de') },
            { path: ['given_name'], mandatory: true, display: claimDisplay('Vorname', 'de') },
            { path: ['family_name'], mandatory: true, display: claimDisplay('Nachname', 'de') },
            { path: ['email'], mandatory: true, display: claimDisplay('E-Mail', 'de') },
            { path: ['phone_number'], mandatory: false, display: claimDisplay('Telefonnummer', 'de') },
            { path: ['birthdate'], mandatory: false, display: claimDisplay('Geburtsdatum', 'de') },
            { path: ['is_over_18'], mandatory: false, display: claimDisplay('Über 18', 'de') },
            { path: ['is_over_21'], mandatory: false, display: claimDisplay('Über 21', 'de') },
            { path: ['is_over_65'], mandatory: false, display: claimDisplay('Über 65', 'de') },
          ],
        },
      },
      [PAYMENT_SCA_ID]: {
        format: 'dc+sd-jwt',
        scope: PAYMENT_SCA_ID,
        vct: buildVctUrl(bank, PAYMENT_SCA_ID),
        ...SDJWT_PROOF_TYPES,
        credential_metadata: {
          display: [
            { name: 'Payment Account (SCA)', locale: 'en' },
            { name: 'Zahlungskonto (SCA)', locale: 'de' },
          ],
          claims: [
            {
              path: ['iban'],
              mandatory: true,
              display: claimDisplay('IBAN'),
            },
            {
              path: ['bic'],
              mandatory: true,
              display: claimDisplay('BIC'),
            },
            {
              path: ['currency'],
              mandatory: true,
              display: claimDisplay('Currency'),
            },
            {
              path: ['category'],
              mandatory: false,
              display: claimDisplay('Attestation Category'),
            },
          ],
        },
      },
    },
    issuerDisplayConfiguration: [
      {
        name: 'walt.id Issuer',
        locale: 'en-US',
        logo: {
          uri: 'https://issuer.example.com/logo.png',
          alt_text: 'walt.id Issuer logo',
        },
      },
      {
        name: 'walt.id Issuer',
        locale: 'de-DE',
        logo: {
          uri: 'https://issuer.example.com/logo-de.png',
          alt_text: 'walt.id Issuer DE Logo',
        },
      },
    ],
    authProviderConfiguration: {
      name: 'Keycloak',
      authorizeUrl: bank.keycloak.authorizeUrl,
      accessTokenUrl: bank.keycloak.accessTokenUrl,
      clientId: bank.keycloak.clientId,
      clientSecret: bank.keycloak.clientSecret,
      defaultScopes: bank.keycloak.defaultScopes,
      forwardIssuerStateToAuthorizationServer: false,
    },
    sdJwtVcTypeMetadataConfiguration: {
      [TAX_CREDENTIAL_ID]: {
        name: 'German Tax Credential',
        description: 'Tax registration and employment attestation.',
      },
      [PAYMENT_SCA_ID]: {
        name: 'Payment Account Attestation',
        description: 'SCA Attestation for a payment account.',
      },
    },
    clientAttestationConfig: {
      required: true,
      verificationMethod: {
        type: 'static-jwk',
        jwk: attesterPublicJwk,
      },
      clockSkewSeconds: 300,
      replayWindowSeconds: 300,
    }
    // clientAuthenticationConfig: {
    //   supportedMethods: [
    //     {
    //       type: "client-attestation",
    //       config: {
    //         verificationMethod: {
    //           type: 'static-jwk',
    //           jwk: attesterPublicJwk,
    //         },
    //       }
    //     }
    //   ]
    // }
  };
}
