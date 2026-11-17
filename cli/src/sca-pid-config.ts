import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { CommandContext } from './context.js';
import { PID_DOC_TYPE, RESOURCES } from './config.js';
import { createHash } from 'node:crypto';
import type { CertificateRequirements } from './commands/setup/certificates.js';
import { SCA_PID_SAMPLE } from './fixtures/sca-pid.js';

export const SCA_PROFILE_IDS = ['sca-card-dpc', 'sca-user'] as const;
export type ScaProfileId = (typeof SCA_PROFILE_IDS)[number];
export const SIGNER_ROLES = ['sca', 'pid', 'verifier', 'provider'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export type TrustConfiguration =
  | { kind: 'fixture' }
  | {
      kind: 'registered';
      chainFile: string;
      /** Optional when reusing an existing signer; required only when importing a new signing key. */
      keyFile?: string;
      anchorsFile: string;
      sourceFile: string;
      sourceSignerFile: string;
      sourceUrl: string;
      publicKeySha256: string;
      /** Select only when the actual registration requires the RSA-2048 WRPAC profile. */
      certificateProfile?: 'wrpac';
      dnsName?: string;
      entityType: string;
      serviceType: string;
    };
export interface ScaPidConfig {
  baseUrl: string;
  organization: string;
  tenant: string;
  /** HTTP is available only for explicitly selected local fixtures. */
  transport: 'https' | 'local';
  branding: { name: string; background: string; text: string; logo?: string; logoIntegrity?: string };
  trust: Record<SignerRole, TrustConfiguration>;
  typeParents?: Record<ScaProfileId, { uri: string; integrity: string }>;
  callbackUrl?: string;
}

function nonempty(value: unknown): asserts value is string {
  assert(typeof value === 'string' && value.trim().length > 0, 'Expected a nonempty configuration value');
}
function httpsUrl(value: unknown): asserts value is string {
  nonempty(value);
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password, 'Expected an HTTPS URL without credentials');
}

export function validateScaPidConfig(value: unknown): ScaPidConfig {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected scenario configuration');
  const c = value as ScaPidConfig;
  const allowed = ['baseUrl', 'organization', 'tenant', 'transport', 'branding', 'trust', 'typeParents', 'callbackUrl'];
  assert(
    Object.keys(c).every((k) => allowed.includes(k)),
    'Unknown scenario configuration field',
  );
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'TLS verification must remain enabled');
  const url = new URL(c.baseUrl);
  assert.equal(url.origin, c.baseUrl, 'Configure an origin without path, query or credentials');
  assert(!url.username && !url.password);
  for (const id of [c.organization, c.tenant])
    assert(typeof id === 'string' && /^[a-z][a-z0-9-]{2,50}$/.test(id), 'Invalid resource identifier');
  assert(c.transport === 'https' || c.transport === 'local', 'Select HTTPS or explicit local transport');
  if (c.transport === 'https') assert.equal(url.protocol, 'https:');
  else
    assert(
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')),
      'Local transport requires a localhost name',
    );
  assert(c.branding && typeof c.branding === 'object');
  nonempty(c.branding.name);
  for (const color of [c.branding.background, c.branding.text])
    assert(/^#[0-9a-f]{6}$/i.test(color), 'Invalid branding colour');
  if (c.branding.logo !== undefined) httpsUrl(c.branding.logo);
  if (c.branding.logoIntegrity !== undefined) {
    assert(c.branding.logo && /^sha256-[A-Za-z0-9+/]{43}=$/.test(c.branding.logoIntegrity), 'Invalid logo integrity');
  }
  assert(
    c.trust && Object.keys(c.trust).sort().join() === [...SIGNER_ROLES].sort().join(),
    'Configure every trust role explicitly',
  );
  for (const role of SIGNER_ROLES) {
    const trust = c.trust[role];
    assert(trust && (trust.kind === 'fixture' || trust.kind === 'registered'), 'Select fixture or registered trust');
    if (trust.kind === 'fixture')
      assert.deepEqual(Object.keys(trust), ['kind'], 'Fixture trust cannot contain registration inputs');
    else {
      for (const key of [
        'chainFile',
        'anchorsFile',
        'sourceFile',
        'sourceSignerFile',
        'entityType',
        'serviceType',
      ] as const)
        nonempty(trust[key]);
      if (trust.keyFile !== undefined) nonempty(trust.keyFile);
      httpsUrl(trust.sourceUrl);
      assert(/^[a-f0-9]{64}$/.test(trust.publicKeySha256), 'Pin the approved signing public key');
      if (trust.certificateProfile !== undefined) {
        assert(role === 'verifier' && trust.certificateProfile === 'wrpac', 'Unsupported certificate profile');
        assert(
          typeof trust.dnsName === 'string' &&
            trust.dnsName.includes('.') &&
            trust.dnsName.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)),
          'WRPAC requires the approved DNS name',
        );
      }
      assert(!new URL(trust.sourceUrl).hash, 'Trust source URL must not have a fragment');
      const allowedEntities = {
        sca: ['TRUST_SERVICE_PROVIDER', 'ATTESTATION_PROVIDER'],
        pid: ['PID_PROVIDER'],
        verifier: ['RELYING_PARTY_PROVIDER', 'ACCESS_CERTIFICATE_PROVIDER'],
        provider: ['WALLET_PROVIDER'],
      };
      assert(allowedEntities[role].includes(trust.entityType), 'Trust entity type does not match its role');
    }
  }
  if (c.typeParents) {
    assert.deepEqual(Object.keys(c.typeParents).sort(), [...SCA_PROFILE_IDS].sort());
    for (const id of SCA_PROFILE_IDS) {
      httpsUrl(c.typeParents[id]?.uri);
      assert(
        /^sha256-[A-Za-z0-9+/]{43}=$/.test(c.typeParents[id]?.integrity),
        'Pin the published parent metadata integrity',
      );
    }
  }
  if (c.callbackUrl) {
    const callback = new URL(c.callbackUrl);
    assert(!callback.username && !callback.password);
    assert(
      callback.protocol === 'https:' ||
        (c.transport === 'local' &&
          callback.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(callback.hostname)),
      'Unsafe callback URL',
    );
  }
  return c;
}

export function readScaPidInput(path: string): { config: ScaPidConfig; sha256: string } {
  const input = readFileSync(path);
  const c = validateScaPidConfig(JSON.parse(input.toString('utf8')));
  for (const trust of Object.values(c.trust))
    if (trust.kind === 'registered') {
      for (const key of ['chainFile', 'keyFile', 'anchorsFile', 'sourceFile', 'sourceSignerFile'] as const) {
        if (trust[key]) trust[key] = resolve(dirname(path), trust[key]);
      }
    }
  return { config: c, sha256: createHash('sha256').update(input).digest('hex') };
}

export function readScaPidConfig(path: string): ScaPidConfig {
  return readScaPidInput(path).config;
}

/** Fixed references keep key provisioning with the operator, outside the recipient role. */
export function holderKeyReference(tenant: string, profile: ScaProfileId, role: 'sca' | 'pid'): string {
  return `${tenant}.${RESOURCES.walletKms}.holder-${profile}-${role}`;
}

export function signerCertificateRequirements(role: SignerRole, trust?: TrustConfiguration): CertificateRequirements {
  if (trust?.kind === 'registered' && trust.certificateProfile === 'wrpac') {
    return {
      algorithms: ['RS256'],
      rsaBits: 2048,
      dnsName: trust.dnsName,
      extendedKeyUsageOids: ['1.3.6.1.5.5.7.3.2'],
    };
  }
  return {
    algorithms: role === 'verifier' ? ['ES256', 'RS256'] : ['ES256'],
    extendedKeyUsageOids:
      role === 'pid' ? ['1.0.18013.5.1.2'] : role === 'provider' || role === 'verifier' ? ['1.3.6.1.5.5.7.3.2'] : [],
  };
}

export function scaPidContext(config: ScaPidConfig, token: string, cliDir: string): CommandContext {
  validateScaPidConfig(config);
  assert(
    typeof token === 'string' && token.length > 0 && token.trim() === token && !/[\r\n]/.test(token),
    'A scoped API token is required',
  );
  const ctx = new CommandContext(
    {
      ...config,
      port: 0,
      email: '',
      password: '',
      superadminToken: '',
      devModeToken: '',
      adminEmail: '',
      adminPassword: '',
    },
    cliDir,
    true,
  );
  ctx.setToken(token);
  return ctx;
}

const text = { type: 'string', minLength: 1 };
const common = {
  iss: { type: 'string', format: 'uri' },
  vct: { type: 'string', format: 'uri' },
  iat: { type: 'integer' },
  exp: { type: 'integer' },
  nbf: { type: 'integer' },
  cnf: { type: 'object', required: ['jwk'] },
  attestation_legal_category: { const: 'non-qualified-EAA' },
};
export function scaProfile(id: ScaProfileId, brand: ScaPidConfig['branding']) {
  const card = id === 'sca-card-dpc';
  const claims = card ? ['credential_id', 'network'] : ['sub'];
  return {
    name: `${brand.name} ${card ? 'SCA-card/DPC' : 'SCA-User'}`,
    claims,
    schema: {
      type: 'object',
      required: [...Object.keys(common).filter((k) => k !== 'nbf'), ...claims],
      properties: {
        ...common,
        ...(card ? { credential_id: text, network: text, card_id: text } : { sub: text, masked_psu_id: text }),
      },
      not: { anyOf: (card ? ['sub', 'pan', 'bin', 'last_four', 'aud'] : ['aud']).map((k) => ({ required: [k] })) },
    },
    issuance: {
      credentialData: {
        attestation_legal_category: 'non-qualified-EAA',
        ...(card ? SCA_PID_SAMPLE.card : SCA_PID_SAMPLE.user),
      },
      mapping: {
        iat: '<timestamp-seconds>',
        nbf: '<timestamp-seconds>',
        exp: '<timestamp-in-seconds:2h>',
        ...(card ? { credential_id: '<uuid>' } : {}),
      },
      selectiveDisclosure: {
        fields: Object.fromEntries((card ? ['credential_id', 'network', 'card_id'] : []).map((k) => [k, { sd: true }])),
      },
    },
  };
}

export function scaTypeMetadata(brand: ScaPidConfig['branding'], parents?: ScaPidConfig['typeParents']) {
  const metadata: Record<string, unknown> = parents
    ? {}
    : { 'sca-payment-base': { name: 'SCA base', schema: { type: 'object', properties: common } } };
  for (const id of SCA_PROFILE_IDS) {
    const profile = scaProfile(id, brand);
    metadata[id] = { extends: `{vctBaseURL}/${id}-base`, schema: profile.schema };
    metadata[id + '-base'] = {
      extends: parents?.[id].uri ?? '{vctBaseURL}/sca-payment-base',
      ...(parents && { 'extends#integrity': parents[id].integrity }),
      name: profile.name,
      display: [
        {
          lang: 'en',
          name: profile.name,
          rendering: {
            simple: {
              background_color: brand.background,
              text_color: brand.text,
              ...(brand.logo && {
                logo: {
                  uri: brand.logo,
                  ...(brand.logoIntegrity && { 'uri#integrity': brand.logoIntegrity }),
                  alt_text: brand.name,
                },
              }),
            },
          },
        },
      ],
      schema: profile.schema,
      claims: profile.claims.map((k) => ({ path: [k], display: [{ lang: 'en', label: k }] })),
    };
  }
  return metadata;
}
export { PID_DOC_TYPE as PID };
