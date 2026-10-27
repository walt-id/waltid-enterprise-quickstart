/**
 * Verifier variants setup (see verifier-variants-config.ts).
 *
 * Runs after --setup-all, which already created what the checks need: the trust registry holding
 * the IACA, the software request-signing key and certificate, and Wallet2's pin on the IACA for
 * signed request objects. On top of that it:
 * - generates the AWS KMS request-signing key and its certificate when a variant has +kms
 * - replaces the wallet's credentials with one per format the variants use (plus the portrait mDL),
 *   each carrying a status list entry and an x5c chain to the IACA, so a variant's +status and
 *   +trust only switch the verifier's checks on
 * - writes one session-creation body per variant to VERIFIER_VARIANTS_DIR, and the variants to
 *   VERIFIER_VARIANTS_FILE as `<variant>\t<format>\t<session request file>` lines
 *
 * The wallet holds exactly one credential per query because it presents the first match in database
 * order, so a status-less copy next to the seeded one could be picked and fail the status check.
 *
 * The AWS key is meant to be temporary: --teardown-verifier-variants schedules its deletion.
 */

import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CommandContext } from '../../context.js';
import {
  RESOURCES,
  KEY_IDS,
  CERT_IDS,
  CERT_VALIDITY_DAYS,
  CLIENT_AUTH_EKU_OID,
  CREDENTIAL_TYPES,
  STATUS_CONFIG_IDS,
  defaultWalletDidReference,
  defaultWalletKeyReference,
  getCredentialType,
} from '../../config.js';
import {
  IssuerVariantFormat,
  buildVariantCredentialData,
  variantCredentialConfigurationId,
  variantProfileName,
  variantStatusConfigId,
} from '../../issuer-variants-config.js';
import {
  PORTRAIT_BYTES,
  RequestSigner,
  VERIFIER_CREDENTIAL_ISSUER,
  VERIFIER_VARIANT_IDS,
  VerifierVariant,
  buildVerificationSessionRequest,
  parseVerifierVariants,
  verifierSessionRequestFileName,
} from '../../verifier-variants-config.js';
import {
  certificatePemToDerBase64,
  certificateValidityWindow,
  createGeneratedCertificate,
  getStoredCertificatePem,
  isoSubjectDn,
  kmsKeyRef,
  x509HashClientId,
  x509StoreCertificateRef,
} from './keys.js';
import {
  createDid,
  createVariantIssuer,
  createVariantStatusList,
  deleteAwsKmsKey,
  ensureDidService,
  generateAwsKmsKey,
  linkIssuerToCredentialStatus,
  requireStoredCertificatePem,
} from './issuer-variants.js';
import { linkVerifier2ToKms } from './tenant.js';
import { clearWalletCredentials } from '../run.js';

const PREFIX = 'VERIFIER-VARIANTS';

function statusConfigRef(ctx: CommandContext, configId: string): string {
  return `${ctx.tenantPath}.${RESOURCES.credentialStatus}.${configId}`;
}

/**
 * Request-signing certificate for the AWS KMS key, issued by the IACA the wallet pins. The wallet verifies
 * the request object with the leaf's public key, so the leaf must be issued for the key that signs.
 */
async function createAwsKmsRequestSigningCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create request-signing certificate for the AWS KMS key', PREFIX);

  if (await getStoredCertificatePem(ctx, VERIFIER_VARIANT_IDS.awsKmsRequestSigningCert)) {
    console.log('   [SKIP] AWS KMS request-signing certificate already exists');
    return;
  }

  await createGeneratedCertificate(
    ctx,
    VERIFIER_VARIANT_IDS.awsKmsRequestSigningCert,
    {
      issuerCertificateRef: x509StoreCertificateRef(ctx, CERT_IDS.vicalIacaCert),
      issuerKeyRef: kmsKeyRef(ctx, KEY_IDS.vicalIacaKey),
      subjectKeyRef: kmsKeyRef(ctx, VERIFIER_VARIANT_IDS.awsKmsRequestSigningKey),
      subjectDn: isoSubjectDn({ country: 'US', commonName: 'Walt CLI AWS KMS Verifier Request Signer' }),
      ...certificateValidityWindow(CERT_VALIDITY_DAYS.verifierRequestSigning),
      basicConstraintsCa: false,
      keyUsage: ['digitalSignature'],
      extendedKeyUsageOids: [CLIENT_AUTH_EKU_OID],
    },
    'aws-kms-verifier-request-signing-cert',
    step
  );
  console.log('   [OK] AWS KMS request-signing certificate created');
}

async function requestSigner(ctx: CommandContext, keyId: string, certId: string, iacaPem: string): Promise<RequestSigner> {
  const leafPem = await requireStoredCertificatePem(ctx, certId);
  return {
    keyReference: kmsKeyRef(ctx, keyId),
    clientId: x509HashClientId(leafPem),
    x5c: [certificatePemToDerBase64(leafPem), certificatePemToDerBase64(iacaPem)],
  };
}

/** Profile on the verifier credentials issuer: the format with status, signed by the document signer, x5c to the IACA */
async function createCredentialProfile(
  ctx: CommandContext,
  format: Exclude<IssuerVariantFormat, 'mdoc'>,
  x5Chain: Array<Record<string, string>>,
  issuerDid: string | undefined
): Promise<string> {
  const step = ctx.nextStep();
  const profile = variantProfileName({ format, status: true });
  const target = `${ctx.tenantPath}.${VERIFIER_CREDENTIAL_ISSUER}.${profile}`;
  ctx.log(`Create ${format} profile for the verifier's credential`, PREFIX);

  const { created } = await ctx.tolerantCreate(`Profile ${target}`, async () => {
    const { credentialData, mapping } = buildVariantCredentialData({ format });
    const request: Record<string, unknown> = {
      name: profile,
      credentialConfigurationId: variantCredentialConfigurationId({ format, status: true }),
      issuerKeyId: kmsKeyRef(ctx, KEY_IDS.issuerSigningKey),
      // What makes +trust possible for SD-JWT and W3C: the credential then carries the same chain to the IACA
      // as the mDL. For W3C the DID and the leaf certificate name the same key.
      x5Chain,
      credentialData,
      credentialStatus: {
        statusCredentialConfig: statusConfigRef(ctx, variantStatusConfigId({ format, kms: false })),
        initialStatus: '0x0',
      },
    };
    if (mapping) request.mapping = mapping;
    if (issuerDid) request.issuerDid = issuerDid;

    ctx.saveJson(`create-verifier-${format}-profile-request.json`, request, step);
    const response = await ctx.orgClient.post(`/v2/${target}/issuer-service-api/credentials/profiles`, request);
    ctx.saveJson(`create-verifier-${format}-profile-response.json`, response.data, step);
    return response;
  });
  if (created) console.log(`   [OK] Profile created: ${target}`);
  return target;
}

/** Issue a credential from [profileTarget] into the wallet, with [runtimeOverrides] applied to the profile */
async function seedCredential(
  ctx: CommandContext,
  label: string,
  profileTarget: string,
  runtimeOverrides?: Record<string, unknown>,
  didReference?: string
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Issue the wallet's ${label}`, PREFIX);

  // Only the overrides the request names are applied; CredentialOfferCreateRequest rejects unknown fields.
  const offer = await ctx.orgClient.post(`/v2/${profileTarget}/issuer-service-api/credentials/offers`, {
    authMethod: 'PRE_AUTHORIZED',
    ...(runtimeOverrides && { runtimeOverrides }),
  });
  const offerUrl = offer.data?.credentialOffer ?? offer.data?.offerUrl;
  if (!offerUrl) {
    throw new Error(`Offer for ${profileTarget} returned no URL: ${JSON.stringify(offer.data).slice(0, 400)}`);
  }

  const request: Record<string, unknown> = { offerUrl, keyReference: defaultWalletKeyReference(ctx.tenantPath) };
  if (didReference) request.didReference = didReference;
  const response = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/receive/pre-authorized`,
    request
  );
  ctx.saveJson(`receive-verifier-${label.replace(/\W+/g, '-')}-response.json`, response.data, step);
  console.log(`   [OK] ${label} received`);
}

/**
 * The vct the SD-JWT credential is issued with, read from the issuer's metadata. `{vctBaseURL}` resolves
 * against the host the issuer is reached on, so the concrete value is not known before the issuer answers.
 */
async function issuedSdJwtVct(ctx: CommandContext, issuerTarget: string, configurationId: string): Promise<string> {
  const url = `${ctx.orgBaseUrl}/.well-known/openid-credential-issuer/v2/${issuerTarget}/issuer-service-api/openid4vci`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Issuer metadata ${url} answered HTTP ${response.status}`);
  }
  const metadata: any = await response.json();
  const vct = metadata?.credential_configurations_supported?.[configurationId]?.vct;
  if (typeof vct !== 'string' || vct.includes('{')) {
    throw new Error(`Issuer metadata ${url} has no resolved vct for ${configurationId}: ${JSON.stringify(vct)}`);
  }
  return vct;
}

/** Replace the wallet's credentials with one per format the variants use. Returns the SD-JWT vct, if any. */
async function seedWalletCredentials(ctx: CommandContext, variants: VerifierVariant[], iacaPem: string): Promise<string | undefined> {
  const formats = new Set(variants.map((v) => v.format));
  const docSignerPem = await requireStoredCertificatePem(ctx, CERT_IDS.docSignerCert);

  await clearWalletCredentials(ctx);

  // mDL from the primary issuer profile, which already carries the document signer chain to the IACA.
  const mdlProfile = `${ctx.tenantPath}.${RESOURCES.issuer}.${RESOURCES.issuerProfile}`;
  const mdocStatus = {
    statusCredentialConfig: statusConfigRef(ctx, STATUS_CONFIG_IDS.tokenStatusListCwt),
    initialStatus: '0x0',
  };
  if (variants.some((v) => v.format === 'mdoc' && !v.portrait)) {
    await seedCredential(ctx, 'mDL', mdlProfile, { credentialStatus: mdocStatus });
  }
  if (variants.some((v) => v.portrait)) {
    // Real bytes, and a byte string rather than text: without base64UrlStringToByteString the portrait would be
    // stored as a CBOR text string, which is a different shape and a different cost. The other claims stay the
    // profile's, so only the portrait differs from the plain mDL.
    const credType = CREDENTIAL_TYPES[getCredentialType()];
    await seedCredential(ctx, 'portrait mDL', mdlProfile, {
      credentialStatus: mdocStatus,
      credentialData: {
        [credType.namespace]: {
          ...credType.credentialData,
          portrait: randomBytes(PORTRAIT_BYTES).toString('base64url'),
        },
      },
      mDocNameSpacesDataMappingConfig: {
        [credType.namespace]: {
          entriesConfigMap: { portrait: { type: 'string', conversionType: 'base64UrlStringToByteString' } },
        },
      },
    });
  }

  if (!formats.has('sdjwt') && !formats.has('w3c')) return undefined;

  const x5Chain = [docSignerPem, iacaPem].map((pem) => ({
    type: 'pem-encoded-x509-certificate-descriptor',
    pemEncodedCertificate: pem,
  }));
  const signer = { keyId: KEY_IDS.issuerSigningKey, certId: CERT_IDS.docSignerCert };
  await createVariantIssuer(ctx, VERIFIER_CREDENTIAL_ISSUER, signer, false);
  await linkIssuerToCredentialStatus(ctx, VERIFIER_CREDENTIAL_ISSUER);

  const dids = new Map<string, string>();
  if (formats.has('w3c')) {
    await ensureDidService(ctx);
    // did:key is derived from the key, so this is the same DID the issuer variants use for this key.
    dids.set(KEY_IDS.issuerSigningKey, await createDid(ctx, KEY_IDS.issuerSigningKey));
  }
  const docSignerPems = new Map([[CERT_IDS.docSignerCert, docSignerPem]]);

  let sdJwtVct: string | undefined;
  const issuerTarget = `${ctx.tenantPath}.${VERIFIER_CREDENTIAL_ISSUER}`;
  if (formats.has('sdjwt')) {
    await createVariantStatusList(ctx, { format: 'sdjwt', kms: false }, dids, docSignerPems);
    const profile = await createCredentialProfile(ctx, 'sdjwt', x5Chain, undefined);
    sdJwtVct = await issuedSdJwtVct(ctx, issuerTarget, variantCredentialConfigurationId({ format: 'sdjwt', status: true }));
    await seedCredential(ctx, 'SD-JWT credential', profile);
    console.log(`   [INFO] SD-JWT vct: ${sdJwtVct}`);
  }
  if (formats.has('w3c')) {
    await createVariantStatusList(ctx, { format: 'w3c', kms: false }, dids, docSignerPems);
    const profile = await createCredentialProfile(ctx, 'w3c', x5Chain, dids.get(KEY_IDS.issuerSigningKey));
    // W3C binds the credential to the holder's DID; mdoc and SD-JWT bind to the key.
    await seedCredential(ctx, 'W3C credential', profile, undefined, defaultWalletDidReference(ctx.tenantPath));
  }
  return sdJwtVct;
}

/**
 * Set up every variant in VERIFIER_VARIANTS (default: mdoc) and write their session requests, one JSON
 * file per variant in VERIFIER_VARIANTS_DIR, listed in VERIFIER_VARIANTS_FILE.
 */
export async function runVerifierVariantsSetup(ctx: CommandContext): Promise<void> {
  const variants = parseVerifierVariants(process.env.VERIFIER_VARIANTS || 'mdoc');
  console.log(`\n=== Verifier variants setup: ${variants.map((v) => v.name).join(', ')} ===\n`);

  const iacaPem = await requireStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert);
  // The verifier resolves a session's keyReference only through a KMS it depends on.
  await linkVerifier2ToKms(ctx);

  const signers: { software: RequestSigner; awsKms?: RequestSigner } = {
    software: await requestSigner(ctx, KEY_IDS.verifierRequestSigningKey, CERT_IDS.verifierRequestSigningCert, iacaPem),
  };
  if (variants.some((v) => v.kms)) {
    await generateAwsKmsKey(ctx, VERIFIER_VARIANT_IDS.awsKmsRequestSigningKey, PREFIX);
    await createAwsKmsRequestSigningCertificate(ctx);
    signers.awsKms = await requestSigner(
      ctx,
      VERIFIER_VARIANT_IDS.awsKmsRequestSigningKey,
      VERIFIER_VARIANT_IDS.awsKmsRequestSigningCert,
      iacaPem
    );
  }

  const sdJwtVct = await seedWalletCredentials(ctx, variants, iacaPem);

  const requestsDir = process.env.VERIFIER_VARIANTS_DIR || join(ctx.cliDir, 'verifier-variants');
  mkdirSync(requestsDir, { recursive: true });
  const lines: string[] = [];
  for (const variant of variants) {
    const file = join(requestsDir, verifierSessionRequestFileName(variant));
    writeFileSync(file, JSON.stringify(buildVerificationSessionRequest(variant, { sdJwtVct, signers }), null, 2));
    lines.push(`${variant.name}\t${variant.format}\t${file}\n`);
  }
  const variantsFile = process.env.VERIFIER_VARIANTS_FILE || join(ctx.cliDir, 'verifier-variants.tsv');
  writeFileSync(variantsFile, lines.join(''));
  console.log(`\n[${PREFIX}] ${variants.length} variant(s) ready, session requests listed in ${variantsFile}`);
}

/**
 * Schedule deletion of the AWS KMS request-signing key through the Enterprise KMS service.
 * AWS keeps a key for at least 7 days after this; it cannot be used in that time.
 */
export async function runVerifierVariantsTeardown(ctx: CommandContext): Promise<void> {
  await deleteAwsKmsKey(ctx, VERIFIER_VARIANT_IDS.awsKmsRequestSigningKey, PREFIX);
}
