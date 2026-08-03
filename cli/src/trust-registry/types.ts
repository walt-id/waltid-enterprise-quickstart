export interface LoadSourceRequest {
  sourceId: string;
  content?: string;
  url?: string;
  sourceUrl?: string;
  acceptancePolicy?: SourceAcceptancePolicy;
  validateSignature?: boolean;
  trustedSignerCertificates?: string[];
}

export interface RefreshResult {
  sourceId: string;
  success: boolean;
  entitiesLoaded?: number;
  servicesLoaded?: number;
  identitiesLoaded?: number;
  pointersLoaded?: number;
  error?: string;
  errorCode?: string;
  assurance?: SourceAssurance;
}

export type SourceAcceptancePolicy =
  | 'REQUIRE_AUTHENTICATED'
  | 'REQUIRE_VALID_SIGNATURE'
  | 'ALLOW_UNSIGNED'
  | 'ALLOW_UNVERIFIED';

export interface SourceAssurance {
  signatureStatus: 'NOT_PRESENT' | 'NOT_CHECKED' | 'VALID' | 'INVALID' | 'UNSUPPORTED';
  signerTrust: 'NOT_APPLICABLE' | 'NOT_EVALUATED' | 'TRUSTED' | 'UNTRUSTED';
  authenticityState: 'AUTHENTICATED' | 'INTEGRITY_VERIFIED' | 'UNVERIFIED' | 'FAILED' | 'UNKNOWN';
  acceptancePolicy: SourceAcceptancePolicy;
  accepted: boolean;
  details?: string;
}

export interface TrustSource {
  sourceId: string;
  sourceFamily: string;
  format: 'ETSI_TS_119_612_TRUST_LIST_XML' | 'ETSI_TS_119_612_LIST_OF_TRUST_LISTS_XML' |
    'ETSI_TS_119_602_JSON' | 'ETSI_TS_119_602_XML' | 'UNKNOWN';
  displayName: string;
  sourceUrl?: string;
  assurance: SourceAssurance;
  freshnessState: 'FRESH' | 'STALE' | 'EXPIRED' | 'UNKNOWN';
  metadata?: Record<string, string>;
}

export interface ResolveCertificateChainRequest {
  certificateChainPemOrDer: string[];
  instant?: string;
  expectedEntityType?: string;
  expectedServiceType?: string;
}

export interface TrustDecision {
  decision: 'TRUSTED' | 'NOT_TRUSTED' | 'STALE_SOURCE' | 'MULTIPLE_MATCHES' |
    'PROCESSING_ERROR' | 'UNSUPPORTED_SOURCE' | 'UNKNOWN';
  sourceFreshness: 'FRESH' | 'STALE' | 'EXPIRED' | 'UNKNOWN';
  sourceAssurance: SourceAssurance;
  matchedSource?: { sourceId: string; displayName: string; sourceFamily: string };
  matchedEntity?: { entityId: string; entityType: string; legalName: string };
  matchedService?: { serviceId: string; serviceType: string; status: string };
  evidence: Array<{ type: string; value: string }>;
  warnings: string[];
}
