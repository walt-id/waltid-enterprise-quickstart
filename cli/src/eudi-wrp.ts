/**
 * WRP Registry request/response helpers.
 *
 * Aligned with the EUDI registrar service (TS5/TS6) as documented in
 * launchpad2026.md and the live /law/create response envelope:
 * `{ code, status, message, data: { "<Entity> new ids:": [id] } }`.
 */

const METADATA_KEYS = new Set(['code', 'status', 'message']);

const ENTITLEMENT_NAMES = [
  'Service_Provider',
  'QEAA_Provider',
  'Non_Q_EAA_Provider',
  'PUB_EAA_Provider',
  'PID_Provider',
  'QCert_for_ESeal_Provider',
  'QCert_for_ESig_Provider',
  'rQSealCDs_Provider',
  'rQSigCDs_Provider',
  'ESig_ESeal_Creation_Provider',
] as const;

const ENTITLEMENT_URIS: Record<string, string> = Object.fromEntries(
  ENTITLEMENT_NAMES.map((name) => [
    name,
    `http://data.europa.eu/eudi/entitlement/${name}`,
  ])
);

const ISSUER_ENTITLEMENT_MARKERS = [
  'PID_Provider',
  'QEAA_Provider',
  'Non_Q_EAA_Provider',
  'PUB_EAA_Provider',
];

const LEGACY_VERIFIER_ENTITLEMENTS = new Set([
  'AGE_VERIFICATION',
  'IDENTITY_VERIFICATION',
]);

/** Collect numeric IDs from a WRP create response body. */
export function extractCreatedIds(response: unknown): number[] {
  if (typeof response === 'number') {
    return [response];
  }
  if (Array.isArray(response)) {
    return response.filter((value): value is number => typeof value === 'number');
  }
  if (response == null || typeof response !== 'object') {
    return [];
  }

  const record = response as Record<string, unknown>;
  if ('data' in record) {
    const fromData = extractCreatedIds(record.data);
    if (fromData.length > 0) {
      return fromData;
    }
    if (record.data !== undefined && record.data !== null) {
      return [];
    }
  }

  const ids: number[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (METADATA_KEYS.has(key)) continue;
    if (typeof value === 'number') {
      ids.push(value);
    } else if (Array.isArray(value)) {
      ids.push(...value.filter((item): item is number => typeof item === 'number'));
    }
  }
  return ids;
}

/** Return the first created ID or throw. */
export function extractCreatedId(response: unknown, entityName: string): number {
  const id = extractCreatedIds(response)[0];
  if (id === undefined) {
    throw new Error(`No ${entityName} ID returned in response`);
  }
  return id;
}

/** PID authorization is not ready yet (wallet has not completed presentation). */
export function isAuthorizationPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('{"error":"400"}') ||
    message.includes('WRP API error 500') ||
    message.includes('404') ||
    message.toLowerCase().includes('not found')
  );
}

/** Parse a claim path from env text into the registrar's JSON-array form. */
export function parseClaimPath(
  raw: string,
  mdocNamespace?: string
): Array<string | number> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Claim path must not be empty');
  }
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(`Claim path must be a non-empty JSON array: ${trimmed}`);
    }
    return parsed as Array<string | number>;
  }
  if (mdocNamespace) {
    if (trimmed.startsWith(`${mdocNamespace}.`) || trimmed.startsWith(`${mdocNamespace}/`)) {
      return [mdocNamespace, trimmed.slice(mdocNamespace.length + 1)];
    }
    return [mdocNamespace, trimmed];
  }
  return trimmed.includes('.') ? trimmed.split('.') : [trimmed];
}

export function parseClaimPaths(
  raw: string,
  mdocNamespace?: string
): Array<Array<string | number>> {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseClaimPath(part, mdocNamespace));
}

export function credentialMetaForFormat(
  format: string,
  options: {
    doctype?: string;
    vctValues?: string[];
    name?: string;
    version?: string;
  }
): Record<string, unknown> {
  if (format === 'mso_mdoc') {
    return { doctype_value: options.doctype || 'eu.europa.ec.eudi.pid.1' };
  }
  if (format === 'dc+sd-jwt') {
    return {
      vct_values: options.vctValues && options.vctValues.length > 0
        ? options.vctValues
        : ['urn:eudi:pid:1'],
    };
  }
  return {
    name: options.name || 'PID Credential',
    version: options.version || '1.0',
  };
}

export interface CredentialCreateItem {
  format: string;
  /** Live registrar requires a JSON string; an object 500s. */
  meta: string;
  claims: Array<{ path: string }>;
}

/**
 * Body for registry.serviceproviders.eudiw.dev `/credential/create`.
 *
 * GitHub `main` serializes `meta` and claim `path` before insert. The public
 * host does not: a JSON-object `meta` returns HTML 500, and an array `path`
 * is dropped even when create returns 201. See
 * eu-digital-identity-wallet/eudi-srv-web-relyingparty-registration-py#32.
 * Both fields must be JSON strings on the wire.
 */
export function buildLiveRegistrarCredentialCreateItem(
  format: string,
  claims: Array<Array<string | number>>,
  meta?: Record<string, unknown>
): CredentialCreateItem {
  const metaObject =
    meta && Object.keys(meta).length > 0
      ? meta
      : { name: 'PID Credential', version: '1.0' };
  return {
    format,
    meta: JSON.stringify(metaObject),
    claims: claims.map((path) => ({ path: JSON.stringify(path) })),
  };
}

export function mdocNamespaceForFormat(format: string, doctype: string): string | undefined {
  return format === 'mso_mdoc' ? doctype : undefined;
}

const IDENTIFIER_TYPE_ALIASES: Record<string, string> = {
  'VAT-No': 'http://data.europa.eu/eudi/id/VATIN',
  VAT: 'http://data.europa.eu/eudi/id/VATIN',
  'http://data.europa.eu/eudi/id/VAT-No': 'http://data.europa.eu/eudi/id/VATIN',
};

/** Map legacy identifier type URIs to the registrar's allowed set. */
export function normalizeIdentifierType(value: string): string {
  const trimmed = value.trim();
  return IDENTIFIER_TYPE_ALIASES[trimmed] || trimmed;
}

/** Expand short names and ETSI URIs to the live registrar entitlement URIs. */
export function normalizeEntitlement(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (LEGACY_VERIFIER_ENTITLEMENTS.has(trimmed)) {
    return ENTITLEMENT_URIS.Service_Provider;
  }
  const suffix = trimmed.split('/').pop();
  if (suffix && ENTITLEMENT_URIS[suffix]) {
    return ENTITLEMENT_URIS[suffix];
  }
  return trimmed;
}

export function shouldRegisterProvidedAttestations(entitlements: string[]): boolean {
  return entitlements.some((entitlement) =>
    ISSUER_ENTITLEMENT_MARKERS.some((marker) => entitlement.includes(marker))
  );
}

export function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function decodeFlexibleBase64(value: string): Buffer {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const urlSafe = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(urlSafe, 'base64');
}
