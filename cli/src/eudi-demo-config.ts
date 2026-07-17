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

// ============================================================================
// Types
// ============================================================================

/** EUDI Demo configuration from environment variables */
export interface EudiDemoConfig {
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
    type: 'WALLET_PROVIDER' | 'RELYING_PARTY_PROVIDER';
    policyUri: string;
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
  };
  /** Credential configuration for verification */
  credential: {
    format: string;
    claims: string[];
    name: string;
    version: string;
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
export function createEudiDemoConfig(): EudiDemoConfig {
  return {
    registryBaseUrl: process.env.EUDI_REGISTRY_BASE_URL || 'https://registry.serviceproviders.eudiw.dev',
    tenantId: process.env.EUDI_TENANT || 'eudi-demo',
    verifierName: process.env.EUDI_VERIFIER_NAME || 'eudi-verifier',
    serviceBaseUrl: process.env.EUDI_SERVICE_BASE_URL || process.env.BASE_URL || 'https://enterprise.walt.id',
    legalEntity: {
      country: process.env.EUDI_LEGAL_ENTITY_COUNTRY || 'AT',
      legalName: process.env.EUDI_LEGAL_ENTITY_NAME || 'walt.id GmbH',
      identifier: process.env.EUDI_LEGAL_ENTITY_IDENTIFIER || 'ATUID123456789',
      identifierType: process.env.EUDI_LEGAL_ENTITY_IDENTIFIER_TYPE || 'http://data.europa.eu/eudi/id/VAT-No',
      email: process.env.EUDI_LEGAL_ENTITY_EMAIL || 'office@walt.id',
      phone: process.env.EUDI_LEGAL_ENTITY_PHONE || '+436648860100',
      postalAddress: process.env.EUDI_LEGAL_ENTITY_ADDRESS || 'Liechtensteinstrasse 111/115, 1090 Vienna, Austria',
      infoUri: process.env.EUDI_LEGAL_ENTITY_INFO_URI || 'https://walt.id',
    },
    provider: {
      type: (process.env.EUDI_PROVIDER_TYPE as 'WALLET_PROVIDER' | 'RELYING_PARTY_PROVIDER') || 'RELYING_PARTY_PROVIDER',
      policyUri: process.env.EUDI_PROVIDER_POLICY_URI || 'https://walt.id/privacy-policy',
    },
    walletRp: {
      tradeName: process.env.EUDI_WRP_TRADE_NAME || 'walt.id Identity Verification',
      description: process.env.EUDI_WRP_DESCRIPTION || 'EUDI Wallet verification service powered by walt.id',
      supportUri: process.env.EUDI_WRP_SUPPORT_URI || 'https://walt.id/contact',
      registryUri: process.env.EUDI_WRP_REGISTRY_URI || 'https://registry.serviceproviders.eudiw.dev',
      isPsb: process.env.EUDI_WRP_IS_PSB === 'true',
      entitlements: (process.env.EUDI_WRP_ENTITLEMENTS || 'AGE_VERIFICATION,IDENTITY_VERIFICATION').split(',').map(s => s.trim()),
    },
    intendedUse: {
      identifier: process.env.EUDI_INTENDED_USE_ID || 'USE-WALTID-001',
      purpose: process.env.EUDI_INTENDED_USE_PURPOSE || 'Identity verification for walt.id enterprise services',
      privacyPolicyUri: process.env.EUDI_INTENDED_USE_PRIVACY_URI || 'https://walt.id/privacy-policy',
    },
    credential: {
      format: process.env.EUDI_CREDENTIAL_FORMAT || 'jwt_vc',
      claims: (process.env.EUDI_CREDENTIAL_CLAIMS || 'credentialSubject.name,credentialSubject.dateOfBirth').split(',').map(s => s.trim()),
      name: process.env.EUDI_CREDENTIAL_NAME || 'PID Credential',
      version: process.env.EUDI_CREDENTIAL_VERSION || '1.0',
    },
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
