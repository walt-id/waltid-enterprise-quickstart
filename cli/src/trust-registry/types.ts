export interface LoadSourceRequest {
  sourceId: string;
  content?: string;
  url?: string;
  sourceUrl?: string;
  validateSignature?: boolean;
  trustedSignerCertificates?: string[];
}

export interface RefreshResult {
  sourceId: string;
  success: boolean;
  entitiesLoaded?: number;
  servicesLoaded?: number;
  identitiesLoaded?: number;
  error?: string;
}

export interface TrustSource {
  sourceId: string;
  sourceFamily: string;
  displayName: string;
  sourceUrl?: string;
  authenticityState: 'VALIDATED' | 'FAILED' | 'SKIPPED_DEMO' | 'UNKNOWN';
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
  authenticity: 'VALIDATED' | 'FAILED' | 'SKIPPED_DEMO' | 'UNKNOWN';
  matchedSource?: { sourceId: string; displayName: string; sourceFamily: string };
  matchedEntity?: { entityId: string; entityType: string; legalName: string };
  matchedService?: { serviceId: string; serviceType: string; status: string };
  evidence: Array<{ type: string; value: string }>;
  warnings: string[];
}
