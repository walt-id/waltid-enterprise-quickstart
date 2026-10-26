/**
 * Issuer variants: one issuer configuration per combination of credential format, credential
 * status, signing key and metadata signing, so the same issuance can be run against each of them.
 *
 * A variant is written as a format followed by optional toggles joined with '+', and several
 * variants are separated by commas:
 *
 *   ISSUER_VARIANTS="mdoc, mdoc+status, sdjwt+kms, w3c+status+kms+signed"
 *
 * - format:  mdoc | sdjwt | w3c
 * - status:  the profile adds a status list entry to every issued credential
 * - kms:     an AWS KMS key signs the access token, the credential, its status list and the
 *            signed metadata - everything the variant signs - instead of the software key
 * - signed:  the issuer service publishes signed metadata
 *
 * Every variant maps to one issuer profile, so a client only needs the profile's target and does
 * not have to know which toggles are behind it.
 */

import {
  CREDENTIAL_TYPES,
  CERT_IDS,
  KEY_IDS,
  STATUS_CONFIG_IDS,
  getCredentialType,
} from './config.js';

export type IssuerVariantFormat = 'mdoc' | 'sdjwt' | 'w3c';

export interface IssuerVariant {
  /** Canonical name, e.g. `sdjwt+status+kms` */
  name: string;
  format: IssuerVariantFormat;
  status: boolean;
  kms: boolean;
  signedMetadata: boolean;
}

const FORMATS: readonly IssuerVariantFormat[] = ['mdoc', 'sdjwt', 'w3c'];
const TOGGLES = ['status', 'kms', 'signed'] as const;

/**
 * Issuer services for the variants, separate from the primary issuer2. The access-token key and
 * signed metadata are configured per service, so each combination of the two needs its own service.
 */
export const ISSUER_VARIANT_SERVICES = {
  software: 'issuer2-software',
  awsKms: 'issuer2-aws-kms',
  softwareSignedMetadata: 'issuer2-software-signed-metadata',
  awsKmsSignedMetadata: 'issuer2-aws-kms-signed-metadata',
} as const;

/** Key, certificate and status-list ids created for the variants */
export const ISSUER_VARIANT_IDS = {
  awsKmsSigningKey: 'aws-kms-signing-key',
  awsKmsDocSignerCert: 'aws-kms-doc-signer-cert',
  tokenStatusListCwtAwsKms: 'token-status-list-cwt-aws-kms',
  tokenStatusListJwt: 'token-status-list-jwt',
  tokenStatusListJwtAwsKms: 'token-status-list-jwt-aws-kms',
  bitstringStatusList: 'bitstring-status-list',
  bitstringStatusListAwsKms: 'bitstring-status-list-aws-kms',
} as const;

/** W3C credential type issued by the w3c variants */
export const ISSUER_VARIANT_W3C_TYPE = 'IdentityCredential';

/**
 * SD-JWT VC type, served by the issuer itself: `{vctBaseURL}` resolves to the issuer's
 * `.well-known/vct` endpoint. The issuer fetches the vct when it creates an offer, so it must be
 * a URL that answers - a URN made that fetch fail with "Connection refused".
 */
export const ISSUER_VARIANT_SDJWT_VCT = '{vctBaseURL}/identity_sdjwt';

/** Parse a comma-separated variant list. Throws on unknown formats or toggles. */
export function parseIssuerVariants(value: string): IssuerVariant[] {
  const variants: IssuerVariant[] = [];
  const seen = new Set<string>();

  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [format, ...toggles] = raw.split('+').map((t) => t.trim().toLowerCase());
    if (!FORMATS.includes(format as IssuerVariantFormat)) {
      throw new Error(`Unknown issuer variant format '${format}' in '${raw}'. Expected one of: ${FORMATS.join(', ')}`);
    }
    for (const toggle of toggles) {
      if (!(TOGGLES as readonly string[]).includes(toggle)) {
        throw new Error(`Unknown issuer variant toggle '${toggle}' in '${raw}'. Expected any of: ${TOGGLES.join(', ')}`);
      }
    }

    const variant: IssuerVariant = {
      name: '',
      format: format as IssuerVariantFormat,
      status: toggles.includes('status'),
      kms: toggles.includes('kms'),
      signedMetadata: toggles.includes('signed'),
    };
    // The toggles are written in a fixed order so 'mdoc+kms+status' and 'mdoc+status+kms' are one variant.
    variant.name = [
      variant.format,
      variant.status ? 'status' : undefined,
      variant.kms ? 'kms' : undefined,
      variant.signedMetadata ? 'signed' : undefined,
    ].filter(Boolean).join('+');

    if (!seen.has(variant.name)) {
      seen.add(variant.name);
      variants.push(variant);
    }
  }

  if (variants.length === 0) {
    throw new Error('No issuer variants given. Example: ISSUER_VARIANTS="mdoc, sdjwt+status"');
  }
  return variants;
}

/** Issuer service the variant's profile lives in: chosen by signing key and metadata signing */
export function variantIssuerService(variant: IssuerVariant): string {
  if (variant.signedMetadata) {
    return variant.kms ? ISSUER_VARIANT_SERVICES.awsKmsSignedMetadata : ISSUER_VARIANT_SERVICES.softwareSignedMetadata;
  }
  return variant.kms ? ISSUER_VARIANT_SERVICES.awsKms : ISSUER_VARIANT_SERVICES.software;
}

/** Profile name: format and status. The signing key and metadata signing come from the service. */
export function variantProfileName(variant: IssuerVariant): string {
  return variant.status ? `${variant.format}-status` : variant.format;
}

/** Full issuer target: `<tenant>.<service>.<profile>` */
export function variantIssuerTarget(tenantPath: string, variant: IssuerVariant): string {
  return `${tenantPath}.${variantIssuerService(variant)}.${variantProfileName(variant)}`;
}

/** KMS key id that signs everything in the variant: access token, credential, status list and metadata */
export function variantSigningKeyId(variant: IssuerVariant): string {
  return variant.kms ? ISSUER_VARIANT_IDS.awsKmsSigningKey : KEY_IDS.issuerSigningKey;
}

/** Certificate for the variant's signing key: the mdoc x5chain, and the x5c of status lists and metadata */
export function variantDocSignerCertId(variant: IssuerVariant): string {
  return variant.kms ? ISSUER_VARIANT_IDS.awsKmsDocSignerCert : CERT_IDS.docSignerCert;
}

/**
 * Status list the variant's profile points at, signed with the variant's key. Every issuance with
 * status re-signs its list, so a kms variant makes a second remote signature per credential.
 * The software mdoc list is the one --setup-all already created.
 */
export function variantStatusConfigId(variant: IssuerVariant): string {
  switch (variant.format) {
    case 'mdoc': return variant.kms ? ISSUER_VARIANT_IDS.tokenStatusListCwtAwsKms : STATUS_CONFIG_IDS.tokenStatusListCwt;
    case 'sdjwt': return variant.kms ? ISSUER_VARIANT_IDS.tokenStatusListJwtAwsKms : ISSUER_VARIANT_IDS.tokenStatusListJwt;
    case 'w3c': return variant.kms ? ISSUER_VARIANT_IDS.bitstringStatusListAwsKms : ISSUER_VARIANT_IDS.bitstringStatusList;
  }
}

const PROOF_TYPES_ES256 = {
  proof_types_supported: {
    jwt: { proof_signing_alg_values_supported: ['ES256'] },
  },
};

/**
 * Credential configuration id a variant's profile issues, e.g. `identity_sdjwt_status`.
 * An issuer binds each configuration to at most one profile, so variants that share a service
 * (`mdoc` and `mdoc+status` both use the software key) need a configuration each.
 */
export function variantCredentialConfigurationId(variant: Pick<IssuerVariant, 'format' | 'status'>): string {
  return `identity_${variant.format}${variant.status ? '_status' : ''}`;
}

function credentialConfiguration(format: IssuerVariantFormat, scope: string): Record<string, unknown> {
  switch (format) {
    case 'mdoc': {
      const docType = CREDENTIAL_TYPES[getCredentialType()].docType;
      return {
        format: 'mso_mdoc',
        doctype: docType,
        scope,
        credential_signing_alg_values_supported: [-7, -9],
        cryptographic_binding_methods_supported: ['cose_key'],
        ...PROOF_TYPES_ES256,
      };
    }
    case 'sdjwt':
      return {
        format: 'dc+sd-jwt',
        scope,
        vct: ISSUER_VARIANT_SDJWT_VCT,
        credential_signing_alg_values_supported: ['ES256'],
        cryptographic_binding_methods_supported: ['jwk'],
        ...PROOF_TYPES_ES256,
      };
    case 'w3c':
      return {
        format: 'jwt_vc_json',
        scope,
        credential_signing_alg_values_supported: ['ES256'],
        // did:jwk is what Wallet2 composable init creates (see tenant.ts); the wallet refuses a DID
        // whose method the issuer does not list.
        cryptographic_binding_methods_supported: ['did:jwk', 'did:key'],
        ...PROOF_TYPES_ES256,
        credential_definition: {
          type: ['VerifiableCredential', ISSUER_VARIANT_W3C_TYPE],
        },
      };
  }
}

/** Credential configurations shared by all variant issuers: one per format, with and without status */
export function buildIssuerVariantCredentialConfigurations(): Record<string, unknown> {
  const configurations: Record<string, unknown> = {};
  for (const format of FORMATS) {
    for (const status of [false, true]) {
      const id = variantCredentialConfigurationId({ format, status });
      configurations[id] = credentialConfiguration(format, id);
    }
  }
  return configurations;
}

/** Type metadata the issuer serves at the SD-JWT vct URL, for both SD-JWT configurations */
export function buildIssuerVariantSdJwtTypeMetadata(): Record<string, unknown> {
  const metadata = {
    name: 'Identity Credential',
    description: 'Sample identity credential issued by the walt.id CLI issuer variants.',
  };
  return Object.fromEntries(
    [false, true].map((status) => [variantCredentialConfigurationId({ format: 'sdjwt', status }), metadata])
  );
}

/** Sample subject data. The same person in every format, so payload size stays comparable. */
const SUBJECT = {
  family_name: 'Doe',
  given_name: 'John',
  birth_date: '1990-01-01',
  issuing_country: 'US',
  issuing_authority: 'Test Authority',
  document_number: 'ID123456789',
};

/** Profile `credentialData` (and `mapping` for W3C) for a variant */
export function buildVariantCredentialData(variant: IssuerVariant): {
  credentialData: Record<string, unknown>;
  mapping?: Record<string, unknown>;
} {
  switch (variant.format) {
    case 'mdoc': {
      const mdoc = CREDENTIAL_TYPES[getCredentialType()];
      return { credentialData: { [mdoc.namespace]: mdoc.credentialData } };
    }
    case 'sdjwt':
      return { credentialData: { ...SUBJECT } };
    case 'w3c':
      return {
        credentialData: {
          '@context': ['https://www.w3.org/2018/credentials/v1'],
          id: 'urn:uuid:placeholder',
          type: ['VerifiableCredential', ISSUER_VARIANT_W3C_TYPE],
          issuanceDate: '2024-01-01T00:00:00Z',
          issuer: { id: 'did:placeholder:issuer' },
          credentialSubject: { id: 'did:placeholder:subject', ...SUBJECT },
        },
        // Filled in per issuance, as in the gov-services W3C profiles
        mapping: {
          id: '<uuid>',
          issuer: { id: '<issuerDid>' },
          credentialSubject: { id: '<subjectDid>' },
          issuanceDate: '<timestamp>',
          expirationDate: '<timestamp-in:365d>',
        },
      };
  }
}
