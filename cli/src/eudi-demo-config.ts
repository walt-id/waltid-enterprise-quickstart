/**
 * EUDI Demo configuration for WRP Registry integration.
 *
 * This module handles configuration for the EUDI Wallet Relying Party (WRP) Registry
 * demo setup, which authenticates via PID/OID4VP and registers a Wallet Relying Party
 * to obtain an RP certificate for verifier2 configuration.
 *
 * Configuration is loaded from cli/eudi-demo.env (see eudi-demo.env.example).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  credentialMetaForFormat,
  mdocNamespaceForFormat,
  normalizeEntitlement,
  normalizeIdentifierType,
  parseClaimPaths,
} from './eudi-wrp.js';

// ============================================================================
// Types
// ============================================================================

export type EudiRegistrarRole = 'service_provider' | 'pid_provider' | 'non_q_eaa_provider';

/** EUDI Demo configuration from environment variables */
export interface EudiDemoConfig {
  role: EudiRegistrarRole;
  /** PKCS#12 / WRPRC filename prefix under cli/certs */
  certFilePrefix: string;
  /** Create a verifier2 service after registration (service-provider only) */
  createVerifier: boolean;
  /** WRP Registry base URL */
  registryBaseUrl: string;
  /** Tenant ID for the EUDI demo verifier */
  tenantId: string;
  /** Verifier service name */
  verifierName: string;
  /** Public base URL for the verifier service */
  serviceBaseUrl: string;
  /** Legal entity information */
  legalEntity: {
    country: string;
    legalName: string;
    identifier: string;
    identifierType: string;
    email: string;
    phone: string;
    postalAddress: string;
    infoUri: string;
  };
  /** Provider information */
  provider: {
    /** Registrar providerType; WalletRelyingParty for an RP verifier */
    type: string;
    policyUri: string;
    policyType: string;
  };
  /** Wallet Relying Party information */
  walletRp: {
    tradeName: string;
    description: string;
    supportUri: string;
    registryUri: string;
    isPsb: boolean;
    entitlements: string[];
  };
  /** Intended use configuration */
  intendedUse: {
    identifier: string;
    purpose: string;
    privacyPolicyUri: string;
    policyType: string;
  };
  /** Credential the RP may request from a wallet */
  credential: {
    format: string;
    claims: Array<Array<string | number>>;
    meta: Record<string, unknown>;
  };
  /** Supervisory authority information */
  supervisoryAuthority: {
    name: string;
    country: string;
    email: string;
    phone: string;
    formUri: string;
  };
  /** Law/legal basis configuration */
  law: {
    legalBasis: string[];
    legislativeIdentifier: string;
  };
  /** Password for PKCS#12 certificate */
  certificatePassword: string;
}

/** WRP Registry authentication state */
export interface WrpAuthState {
  presentationId: string;
  qrCodeData: string;
  hashPid?: string;
}

/** WRP Registry entity IDs created during setup */
export interface WrpEntityIds {
  lawId?: number;
  legalPersonId?: number;
  identifierId?: number;
  legalEntityId?: number;
  policyWrpId?: number;
  policyIntendedUseId?: number;
  providerId?: number;
  credentialId?: number;
  intendedUseId?: number;
  providedAttestationId?: number;
  supervisoryAuthorityId?: number;
  walletRpId?: number;
}

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load EUDI demo environment variables from cli/eudi-demo.env.
 * Falls back to defaults if file doesn't exist.
 */
export function loadEudiDemoEnv(cliDir: string): void {
  const envPath = join(cliDir, 'eudi-demo.env');

  if (!existsSync(envPath)) {
    console.log('[EUDI-DEMO] No eudi-demo.env found, using defaults');
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if not already set in environment
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  console.log('[EUDI-DEMO] Loaded configuration from eudi-demo.env');
}

// ============================================================================
// Configuration Factory
// ============================================================================

/**
 * Create EUDI demo configuration from environment variables.
 */
export function createEudiDemoConfig(
  role: EudiRegistrarRole = 'service_provider'
): EudiDemoConfig {
  const profile = eudiRegistrarRoleProfile(role);
  return {
    role,
    certFilePrefix: profile.certFilePrefix,
    createVerifier: profile.createVerifier,
    registryBaseUrl: process.env.EUDI_REGISTRY_BASE_URL || 'https://registry.serviceproviders.eudiw.dev',
    tenantId: process.env.EUDI_TENANT || 'eudi-demo',
    verifierName: process.env.EUDI_VERIFIER_NAME || 'eudi-verifier',
    serviceBaseUrl: process.env.EUDI_SERVICE_BASE_URL || process.env.BASE_URL || 'https://enterprise.walt.id',
    legalEntity: {
      country: process.env.EUDI_LEGAL_ENTITY_COUNTRY || 'AT',
      legalName: process.env.EUDI_LEGAL_ENTITY_NAME || 'walt.id GmbH',
      identifier: process.env.EUDI_LEGAL_ENTITY_IDENTIFIER || 'ATUID123456789',
      identifierType: normalizeIdentifierType(
        process.env.EUDI_LEGAL_ENTITY_IDENTIFIER_TYPE || 'http://data.europa.eu/eudi/id/VATIN'
      ),
      email: process.env.EUDI_LEGAL_ENTITY_EMAIL || 'office@walt.id',
      phone: process.env.EUDI_LEGAL_ENTITY_PHONE || '+436648860100',
      postalAddress: process.env.EUDI_LEGAL_ENTITY_ADDRESS || 'Liechtensteinstrasse 111/115, 1090 Vienna, Austria',
      infoUri: process.env.EUDI_LEGAL_ENTITY_INFO_URI || 'https://walt.id',
    },
    provider: {
      type: process.env.EUDI_PROVIDER_TYPE || 'WalletRelyingParty',
      policyUri: process.env.EUDI_PROVIDER_POLICY_URI || 'https://walt.id/privacy-policy',
      policyType: process.env.EUDI_PROVIDER_POLICY_TYPE || 'http://data.europa.eu/eudi/policy/privacy-policy',
    },
    walletRp: {
      tradeName: role === 'service_provider'
        ? (process.env.EUDI_WRP_TRADE_NAME || profile.tradeName)
        : profile.tradeName,
      description: role === 'service_provider'
        ? (process.env.EUDI_WRP_DESCRIPTION || profile.description)
        : profile.description,
      supportUri: process.env.EUDI_WRP_SUPPORT_URI || 'https://walt.id/contact',
      registryUri: process.env.EUDI_WRP_REGISTRY_URI || 'https://registry.serviceproviders.eudiw.dev',
      isPsb: process.env.EUDI_WRP_IS_PSB === 'true',
      entitlements: profile.entitlements,
    },
    intendedUse: {
      identifier: role === 'service_provider'
        ? (process.env.EUDI_INTENDED_USE_ID || profile.intendedUseId)
        : profile.intendedUseId,
      purpose: role === 'service_provider'
        ? (process.env.EUDI_INTENDED_USE_PURPOSE || profile.purpose)
        : profile.purpose,
      privacyPolicyUri: process.env.EUDI_INTENDED_USE_PRIVACY_URI || 'https://walt.id/privacy-policy',
      policyType: process.env.EUDI_INTENDED_USE_POLICY_TYPE || 'http://data.europa.eu/eudi/policy/privacy-statement',
    },
    credential: buildCredentialConfig(role),
    supervisoryAuthority: {
      name: process.env.EUDI_SUPERVISORY_AUTHORITY_NAME || 'DSB',
      country: process.env.EUDI_SUPERVISORY_AUTHORITY_COUNTRY || 'AT',
      email: process.env.EUDI_SUPERVISORY_AUTHORITY_EMAIL || 'dsb@dsb.gv.at',
      phone: process.env.EUDI_SUPERVISORY_AUTHORITY_PHONE || '+43152152',
      formUri: process.env.EUDI_SUPERVISORY_AUTHORITY_FORM_URI || 'https://www.dsb.gv.at/kontakt',
    },
    law: {
      legalBasis: (process.env.EUDI_LAW_LEGAL_BASIS || 'consent,contract').split(',').map(s => s.trim()),
      legislativeIdentifier: process.env.EUDI_LAW_LEGISLATIVE_ID || 'GDPR-ART-6',
    },
    certificatePassword: process.env.EUDI_CERTIFICATE_PASSWORD || 'WaltIdEudi2024!',
  };
}

export function eudiRegistrarRoleProfile(role: EudiRegistrarRole): {
  entitlements: string[];
  tradeName: string;
  description: string;
  intendedUseId: string;
  purpose: string;
  certFilePrefix: string;
  createVerifier: boolean;
} {
  if (role === 'pid_provider') {
    return {
      entitlements: [normalizeEntitlement('PID_Provider')],
      tradeName: 'walt.id PID Provider',
      description: 'Person Identification Data issuance service powered by walt.id',
      intendedUseId: 'USE-WALTID-PID-001',
      purpose: 'Issuance of Person Identification Data',
      certFilePrefix: 'eudi-pid-provider',
      createVerifier: false,
    };
  }
  if (role === 'non_q_eaa_provider') {
    return {
      entitlements: [normalizeEntitlement('Non_Q_EAA_Provider')],
      tradeName: 'walt.id EAA Provider',
      description: 'Non-qualified electronic attestation issuance service powered by walt.id',
      intendedUseId: 'USE-WALTID-EAA-001',
      purpose: 'Issuance of non-qualified electronic attestations of attributes',
      certFilePrefix: 'eudi-eaa-provider',
      createVerifier: false,
    };
  }
  return {
    entitlements: (process.env.EUDI_WRP_ENTITLEMENTS || 'Service_Provider')
      .split(',')
      .map((value) => normalizeEntitlement(value))
      .filter(Boolean),
    tradeName: 'walt.id Identity Verification',
    description: 'EUDI Wallet verification service powered by walt.id',
    intendedUseId: 'USE-WALTID-001',
    purpose: 'Identity verification for walt.id enterprise services',
    certFilePrefix: 'eudi-rp',
    createVerifier: true,
  };
}

function splitCsv(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildCredentialConfig(role: EudiRegistrarRole): EudiDemoConfig['credential'] {
  const isEaa = role === 'non_q_eaa_provider';
  const format = (isEaa ? process.env.EUDI_EAA_CREDENTIAL_FORMAT : process.env.EUDI_CREDENTIAL_FORMAT)
    || 'mso_mdoc';
  const doctype = (isEaa ? process.env.EUDI_EAA_CREDENTIAL_DOCTYPE : process.env.EUDI_CREDENTIAL_DOCTYPE)
    || (isEaa ? 'org.iso.18013.5.1.mDL' : 'eu.europa.ec.eudi.pid.1');
  const vctValues = splitCsv(
    isEaa ? process.env.EUDI_EAA_CREDENTIAL_VCT : process.env.EUDI_CREDENTIAL_VCT,
    isEaa ? 'urn:eudi:mdl:1' : 'urn:eudi:pid:1'
  );
  const claimsRaw = (isEaa ? process.env.EUDI_EAA_CREDENTIAL_CLAIMS : process.env.EUDI_CREDENTIAL_CLAIMS)
    || (isEaa
      ? 'family_name,given_name,birth_date,document_number'
      : 'given_name,family_name,birth_date');
  const metaJson = isEaa ? process.env.EUDI_EAA_CREDENTIAL_META : process.env.EUDI_CREDENTIAL_META;

  let meta: Record<string, unknown>;
  if (metaJson) {
    meta = JSON.parse(metaJson) as Record<string, unknown>;
  } else {
    meta = credentialMetaForFormat(format, {
      doctype,
      vctValues,
      name: isEaa
        ? (process.env.EUDI_EAA_CREDENTIAL_NAME || 'mDL Credential')
        : process.env.EUDI_CREDENTIAL_NAME,
      version: isEaa
        ? process.env.EUDI_EAA_CREDENTIAL_VERSION
        : process.env.EUDI_CREDENTIAL_VERSION,
    });
  }

  return {
    format,
    claims: parseClaimPaths(claimsRaw, mdocNamespaceForFormat(format, doctype)),
    meta,
  };
}

// ============================================================================
// Verifier Configuration Builders
// ============================================================================

/**
 * Build verifier client metadata for EUDI demo verifier.
 */
export function buildEudiVerifierClientMetadata(
  config: EudiDemoConfig
): Record<string, unknown> {
  return {
    client_name: config.walletRp.tradeName,
    logo_uri: `https://docs.walt.id/logo-2.png`,
    tos_uri: config.provider.policyUri,
    policy_uri: config.intendedUse.privacyPolicyUri,
    contacts: [config.legalEntity.email],
  };
}
