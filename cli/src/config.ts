/**
 * Configuration types, constants, and environment handling for the walt.id CLI.
 * 
 * This module contains all static configuration including:
 * - Resource names and IDs
 * - Type definitions for Config and WaltContext
 * - Environment variable parsing
 * - URL building utilities
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Resource Constants
// ============================================================================

/** Service resource names used in API paths */
export const RESOURCES = {
  wallet: 'wallet',
  issuer: 'issuer2',
  verifier2: 'verifier2',
  x509Service: 'x509-service',
  x509Store: 'x509-store',
  kms: 'kms',
  /** DID service for issuer DIDs */
  didService: 'did-service',
  /** DID store for issuer DIDs */
  didStore: 'did-store',
  /** Dedicated KMS for wallet keys (separate from issuer/x509 KMS) */
  walletKms: 'wallet-kms',
  walletDidService: 'wallet-did-service',
  walletDidStore: 'wallet-didstore',
  walletCredentialStore: 'wallet-credentialstore',
  vical: 'vical',
  clientAttester: 'client-attester',
  issuerProfile: 'mdl-profile',
  trustRegistry: 'trust-registry',
  credentialStore: 'credentialstore',
  credentialStatus: 'credential-status',
} as const;

/** Key IDs for cryptographic keys */
export const KEY_IDS = {
  vicalIacaKey: 'vical-iaca-key',
  issuerSigningKey: 'issuer-signing-key',
  vicalSigningKey: 'vical-signing-key',
  attesterSigningKey: 'attester-signing-key',
} as const;

/** Status configuration IDs */
export const STATUS_CONFIG_IDS = {
  tokenStatusListCwt: 'token-status-list-cwt',
} as const;

/** Certificate IDs */
export const CERT_IDS = {
  vicalIacaCert: 'vical-iaca-cert',
  docSignerCert: 'vical-doc-signer-cert',
  vicalSignerCert: 'vical-signer-cert',
} as const;

/** mDL document type */
export const MDL_DOC_TYPE = 'org.iso.18013.5.1.mDL';

/** Verifier2 client ID */
export const VERIFIER2_CLIENT_ID = 'walt-cli-verifier';

// ============================================================================
// Type Definitions
// ============================================================================

/** CLI configuration from environment variables */
export interface Config {
  baseUrl: string;
  organization: string;
  tenant: string;
  email: string;
  password: string;
  port: number;
  superadminToken: string;
  adminEmail: string;
  adminPassword: string;
  /** Custom domain for host alias (optional) */
  hostAliasDomain?: string;
  /** Host alias service target (optional, default: {organization}.host-alias) */
  hostAliasTarget?: string;
}

/** Runtime context maintained during CLI execution */
export interface WaltContext {
  token: string;
  workdir: string;
  tenantPath: string;
  orgBaseUrl: string;
  stepCounter: number;
  
  // Admin user state
  adminUserId: string;
  adminToken: string;
  
  // Service state
  walletKeyRef: string;
  walletDid: string;
  iacaPem: string;
  docSignerPem: string;
  clientAttestationJwt: string;
  vicalVersionIdPath: string;
  
  // Run state
  offerId: string;
  sessionId: string;
  requestUrl: string;
  trustRegistrySourceId: string;
  
  // Credential status state
  issuerSessionIdWithStatus: string;
}

/** Superadmin credentials from config file */
export interface SuperadminCredentials {
  token: string;
  email: string;
  password: string;
}

// ============================================================================
// URL Building Utilities
// ============================================================================

/**
 * Build base URL from configuration.
 * Handles both http:// and https:// protocols.
 * Port 0 or undefined means no explicit port (use default for protocol).
 */
export function buildBaseUrl(baseUrl: string, port: number | undefined): string {
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    if (port && port > 0) {
      const url = new URL(baseUrl);
      url.port = String(port);
      return url.origin;
    }
    return new URL(baseUrl).origin;
  }
  // For bare hostnames, add protocol and optional port
  const portStr = port && port > 0 ? `:${port}` : '';
  return `http://${baseUrl}${portStr}`;
}

/**
 * Build organization-scoped URL.
 * Inserts organization as subdomain.
 */
export function buildOrgUrl(baseUrl: string, organization: string, port: number | undefined): string {
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    const url = new URL(baseUrl);
    url.hostname = `${organization}.${url.hostname}`;
    if (port && port > 0) {
      url.port = String(port);
    }
    return url.origin;
  }
  const portStr = port && port > 0 ? `:${port}` : '';
  return `http://${organization}.${baseUrl}${portStr}`;
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Read superadmin credentials from config file.
 * Falls back to empty values if file doesn't exist.
 */
export function readSuperadminConfig(configDir: string): SuperadminCredentials {
  const configPath = join(configDir, 'config', 'superadmin-registration.conf');
  
  const defaults: SuperadminCredentials = {
    token: '',
    email: '',
    password: '',
  };
  
  if (!existsSync(configPath)) {
    return defaults;
  }
  
  try {
    const content = readFileSync(configPath, 'utf-8');
    
    const tokenMatch = content.match(/tokens\s*=\s*\{\s*"([^"]+)"/);
    if (tokenMatch) defaults.token = tokenMatch[1];
    
    const emailMatch = content.match(/email\s*=\s*"([^"]+)"/);
    if (emailMatch) defaults.email = emailMatch[1];
    
    const passwordMatch = content.match(/password\s*=\s*"([^"]+)"/);
    if (passwordMatch) defaults.password = passwordMatch[1];
    
    return defaults;
  } catch {
    return defaults;
  }
}

/**
 * Create configuration from environment variables.
 * @param projectRoot - Root directory of the project (for config file lookup)
 */
export function createConfig(projectRoot: string): Config {
  const superadminCreds = readSuperadminConfig(projectRoot);
  
  return {
    baseUrl: process.env.BASE_URL || 'enterprise.localhost',
    organization: process.env.ORGANIZATION || 'waltid',
    tenant: process.env.TENANT || `${process.env.ORGANIZATION || 'waltid'}-tenant01`,
    email: process.env.EMAIL || superadminCreds.email || '',
    password: process.env.PASSWORD || superadminCreds.password || '',
    port: process.env.PORT !== undefined && process.env.PORT !== '' 
      ? parseInt(process.env.PORT) 
      : 0,  // Default to no port (uses protocol default: 80 for HTTP, 443 for HTTPS)
    superadminToken: process.env.SUPERADMIN_TOKEN || superadminCreds.token || '',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@walt.id',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123456',
    hostAliasDomain: process.env.HOST_ALIAS_DOMAIN || undefined,
    hostAliasTarget: process.env.HOST_ALIAS_TARGET || undefined,
  };
}

/** Default host-alias API target for an organization */
export function defaultHostAliasTarget(organization: string): string {
  return `${organization}.host-alias`;
}

/**
 * Create initial context with default values.
 */
export function createInitialContext(
  config: Config,
  workdir: string,
  orgBaseUrl: string
): WaltContext {
  return {
    workdir,
    tenantPath: `${config.organization}.${config.tenant}`,
    orgBaseUrl,
    token: '',
    stepCounter: 0,
    adminUserId: '',
    adminToken: '',
    walletKeyRef: '',
    walletDid: '',
    iacaPem: '',
    docSignerPem: '',
    clientAttestationJwt: '',
    vicalVersionIdPath: '',
    offerId: '',
    sessionId: '',
    requestUrl: '',
    trustRegistrySourceId: '',
    issuerSessionIdWithStatus: '',
  };
}
