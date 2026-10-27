/**
 * Verifier variants: one verification session setup per combination of credential format,
 * verifier checks and request protection, so the same presentation can be run against each.
 *
 * A variant is written as a format followed by optional toggles joined with '+', and several
 * variants are separated by commas:
 *
 *   VERIFIER_VARIANTS="mdoc, mdoc+portrait, sdjwt+status, w3c+trust+signed+encrypted+kms"
 *
 * - format:     mdoc | sdjwt | w3c
 * - status:     the verifier checks the credential's status list entry
 * - trust:      the verifier checks the issuer's certificate chain against the trust registry
 * - signed:     the authorization request is a signed request object (x509_hash client id)
 * - encrypted:  the wallet encrypts its response to a per-session verifier key (direct_post.jwt)
 * - kms:        an AWS KMS key signs the request object instead of the software key; needs +signed
 * - portrait:   mdoc only; the query also asks for a ~250 KB portrait, the only binary claim
 *
 * Every variant verifies the issuer signature. A variant maps to one complete session-creation
 * body, so a client only has to post it and does not have to know which toggles are behind it.
 */

import { CREDENTIAL_TYPES, getCredentialType } from './config.js';
import { IssuerVariantFormat, ISSUER_VARIANT_W3C_TYPE } from './issuer-variants-config.js';
import { MDL_ISSUER_SERVICE_TYPE } from './trust-registry/index.js';

export interface VerifierVariant {
  /** Canonical name, e.g. `sdjwt+status+signed` */
  name: string;
  format: IssuerVariantFormat;
  status: boolean;
  trust: boolean;
  signed: boolean;
  encrypted: boolean;
  kms: boolean;
  portrait: boolean;
}

const FORMATS: readonly IssuerVariantFormat[] = ['mdoc', 'sdjwt', 'w3c'];
/** Also the order toggles are written in a canonical name */
const TOGGLES = ['status', 'trust', 'signed', 'encrypted', 'kms', 'portrait'] as const;

/** Key and certificate ids created for the variants */
export const VERIFIER_VARIANT_IDS = {
  awsKmsRequestSigningKey: 'aws-kms-verifier-request-signing-key',
  awsKmsRequestSigningCert: 'aws-kms-verifier-request-signing-cert',
} as const;

/**
 * Issuer service the wallet's SD-JWT and W3C credentials are issued from. Separate from the issuer
 * variants so their profiles, which the issuer arms measure, stay as they are.
 */
export const VERIFIER_CREDENTIAL_ISSUER = 'issuer2-verifier-credentials';

/** Portrait size, in bytes before base64, for +portrait. Matches the production payload that caused an OOM. */
export const PORTRAIT_BYTES = 250_000;

/** Claims the SD-JWT query asks for: the same three as the mDL query, so payloads stay comparable */
const SDJWT_CLAIMS = ['family_name', 'given_name', 'birth_date'];

/** Parse a comma-separated variant list. Throws on unknown formats or toggles and on invalid combinations. */
export function parseVerifierVariants(value: string): VerifierVariant[] {
  const variants: VerifierVariant[] = [];
  const seen = new Set<string>();

  for (const raw of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [format, ...toggles] = raw.split('+').map((t) => t.trim().toLowerCase());
    if (!FORMATS.includes(format as IssuerVariantFormat)) {
      throw new Error(`Unknown verifier variant format '${format}' in '${raw}'. Expected one of: ${FORMATS.join(', ')}`);
    }
    for (const toggle of toggles) {
      if (!(TOGGLES as readonly string[]).includes(toggle)) {
        throw new Error(`Unknown verifier variant toggle '${toggle}' in '${raw}'. Expected any of: ${TOGGLES.join(', ')}`);
      }
    }

    const variant: VerifierVariant = {
      name: '',
      format: format as IssuerVariantFormat,
      status: toggles.includes('status'),
      trust: toggles.includes('trust'),
      signed: toggles.includes('signed'),
      encrypted: toggles.includes('encrypted'),
      kms: toggles.includes('kms'),
      portrait: toggles.includes('portrait'),
    };
    // +kms picks the key that signs the request object, so without +signed it would change nothing.
    if (variant.kms && !variant.signed) {
      throw new Error(`'${raw}': +kms selects the request-signing key, so it needs +signed`);
    }
    if (variant.portrait && variant.format !== 'mdoc') {
      throw new Error(`'${raw}': +portrait is an mDL claim, so it needs the mdoc format`);
    }
    variant.name = [variant.format, ...TOGGLES.filter((t) => variant[t])].join('+');

    if (!seen.has(variant.name)) {
      seen.add(variant.name);
      variants.push(variant);
    }
  }

  if (variants.length === 0) {
    throw new Error('No verifier variants given. Example: VERIFIER_VARIANTS="mdoc, sdjwt+status"');
  }
  return variants;
}

/** DCQL credential query id, also the key of the variant's specific_vc_policies */
export function verifierQueryId(variant: Pick<VerifierVariant, 'format'>): string {
  return `loadtest_${variant.format}`;
}

/** DCQL credential query for a variant. [sdJwtVct] is the vct the seeded SD-JWT credential was issued with. */
export function buildVerifierCredentialQuery(
  variant: Pick<VerifierVariant, 'format' | 'portrait'>,
  sdJwtVct?: string
): Record<string, unknown> {
  const id = verifierQueryId(variant);
  switch (variant.format) {
    case 'mdoc': {
      const mdoc = CREDENTIAL_TYPES[getCredentialType()];
      const claims = variant.portrait ? [...mdoc.claims, 'portrait'] : mdoc.claims;
      return {
        id,
        format: 'mso_mdoc',
        meta: { doctype_value: mdoc.docType },
        claims: claims.map((claim) => ({ path: [mdoc.namespace, claim] })),
      };
    }
    case 'sdjwt':
      if (!sdJwtVct) throw new Error('An sdjwt variant needs the vct of the SD-JWT credential in the wallet');
      return {
        id,
        format: 'dc+sd-jwt',
        meta: { vct_values: [sdJwtVct] },
        claims: SDJWT_CLAIMS.map((claim) => ({ path: [claim] })),
      };
    case 'w3c':
      // No claims: jwt_vc_json has no selective disclosure, so the whole credential is presented anyway.
      return {
        id,
        format: 'jwt_vc_json',
        meta: { type_values: [['VerifiableCredential', ISSUER_VARIANT_W3C_TYPE]] },
      };
  }
}

/**
 * Session policies. `signature` runs on every credential; the status and trust checks are scoped to the
 * variant's query, because vc_policies run on every format and `credential-status` with the ietf
 * discriminator fails outright on a W3C credential.
 */
export function buildVerifierPolicies(variant: Pick<VerifierVariant, 'format' | 'status' | 'trust'>): Record<string, unknown> {
  const specific: Record<string, unknown>[] = [];
  if (variant.status) {
    specific.push({
      policy: 'credential-status',
      argument: variant.format === 'w3c'
        ? { discriminator: 'w3c', value: 0, purpose: 'revocation', type: 'BitstringStatusList' }
        : { discriminator: 'ietf', value: 0 },
    });
  }
  if (variant.trust) {
    // The trust list holds one entry, the IACA as an mDL issuer (see loadIacaIntoTrustRegistry). Every
    // seeded credential carries an x5c chain to that IACA, so all three formats match it the same way.
    specific.push({
      policy: 'etsi-trust-list',
      expectedEntityType: 'PID_PROVIDER',
      expectedServiceType: MDL_ISSUER_SERVICE_TYPE,
      allowStaleSource: true,
      requireAuthenticated: false,
    });
  }
  return {
    vc_policies: [{ policy: 'signature' }],
    ...(specific.length > 0 && { specific_vc_policies: { [verifierQueryId(variant)]: specific } }),
  };
}

/** Key that signs a variant's request object, and what the wallet authenticates it by */
export interface RequestSigner {
  keyReference: string;
  /** `x509_hash:` of the leaf certificate */
  clientId: string;
  /** [leaf, IACA] as base64 DER */
  x5c: string[];
}

/**
 * Complete session-creation body for a variant.
 *
 * Enterprise wants a key reference whenever the request is signed or the response encrypted, even though
 * encryption alone uses a per-session key generated by the verifier and signs nothing.
 */
export function buildVerificationSessionRequest(
  variant: VerifierVariant,
  options: { sdJwtVct?: string; signers: { software: RequestSigner; awsKms?: RequestSigner } }
): Record<string, unknown> {
  const coreFlow: Record<string, unknown> = {
    dcql_query: { credentials: [buildVerifierCredentialQuery(variant, options.sdJwtVct)] },
    policies: buildVerifierPolicies(variant),
  };
  const request: Record<string, unknown> = { flow_type: 'cross_device' };

  if (variant.signed || variant.encrypted) {
    const signer = variant.kms ? options.signers.awsKms : options.signers.software;
    if (!signer) throw new Error(`Variant ${variant.name} needs the AWS KMS request signer`);
    // Top level, not in core_flow: the controller reads it from there and rejects it inside core_flow.
    request.keyReference = signer.keyReference;
    if (variant.signed) {
      coreFlow.signed_request = true;
      coreFlow.clientId = signer.clientId;
      coreFlow.x5c = signer.x5c;
    }
  }
  if (variant.encrypted) {
    coreFlow.encrypted_response = true;
  }

  request.core_flow = coreFlow;
  return request;
}

/** File name of a variant's session request, e.g. `sdjwt-status-signed.json` */
export function verifierSessionRequestFileName(variant: Pick<VerifierVariant, 'name'>): string {
  return `${variant.name.replace(/\+/g, '-')}.json`;
}
