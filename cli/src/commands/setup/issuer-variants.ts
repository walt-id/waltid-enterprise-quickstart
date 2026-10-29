/**
 * Issuer variants setup (see issuer-variants-config.ts).
 *
 * Runs after --setup-all and adds what the variants in ISSUER_VARIANTS need on top of it: an
 * AWS KMS key and its document signer certificate, issuer DIDs, a status list per format and
 * signing key, up to four issuer services (software or AWS KMS key, with or without signed
 * metadata) and one profile per variant. In a kms variant the AWS key signs the access token,
 * the credential, its status list and the metadata. The resulting targets are written to a TSV
 * file, one line per variant.
 *
 * The AWS key is meant to be temporary: --teardown-issuer-variants schedules its deletion.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CommandContext } from '../../context.js';
import {
  RESOURCES,
  KEY_IDS,
  CERT_IDS,
  CERT_PROFILES,
  CERT_VALIDITY_DAYS,
  CLI_IACA_IAN_URI,
  CLI_DS_CRL_URI,
  STATUS_CONFIG_IDS,
} from '../../config.js';
import {
  IssuerVariant,
  ISSUER_VARIANT_IDS,
  buildIssuerVariantCredentialConfigurations,
  buildIssuerVariantSdJwtTypeMetadata,
  buildVariantCredentialData,
  parseIssuerVariants,
  variantCredentialConfigurationId,
  variantDocSignerCertId,
  variantIssuerService,
  variantIssuerTarget,
  variantProfileName,
  variantSigningKeyId,
  variantStatusConfigId,
} from '../../issuer-variants-config.js';
import {
  certificateValidityWindow,
  createGeneratedCertificate,
  getStoredCertificatePem,
  isoSubjectDn,
  kmsKeyRef,
  x509StoreCertificateRef,
} from './keys.js';

const PREFIX = 'ISSUER-VARIANTS';

function statusConfigRef(ctx: CommandContext, configId: string): string {
  return `${ctx.tenantPath}.${RESOURCES.credentialStatus}.${configId}`;
}

/** Load a certificate that --setup-all must already have created */
export async function requireStoredCertificatePem(ctx: CommandContext, certId: string): Promise<string> {
  const pem = await getStoredCertificatePem(ctx, certId);
  if (!pem) {
    throw new Error(`Certificate '${certId}' not found. Run --setup-all before --setup-issuer-variants.`);
  }
  return pem;
}

function awsKmsAuthFromEnv(): { accessKeyId: string; secretAccessKey: string; region: string } {
  const accessKeyId = process.env.AWS_KMS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_KMS_SECRET_ACCESS_KEY || '';
  const region = process.env.AWS_KMS_REGION || '';
  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('A kms variant needs AWS_KMS_ACCESS_KEY_ID, AWS_KMS_SECRET_ACCESS_KEY and AWS_KMS_REGION');
  }
  return { accessKeyId, secretAccessKey, region };
}

/**
 * Generate an AWS KMS key through the Enterprise KMS service and record its AWS key id in
 * AWS_KMS_KEYS_FILE, so it can still be deleted directly in AWS if the teardown command never runs.
 * The file is shared with --setup-verifier-variants, so keys are added to it rather than replacing it.
 */
export async function generateAwsKmsKey(ctx: CommandContext, keyId: string, prefix: string): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Generate AWS KMS key ${keyId}`, prefix);

  const auth = awsKmsAuthFromEnv();
  const keyRef = kmsKeyRef(ctx, keyId);
  // Not saved with saveJson: the request and the response both carry the access key. The HTTP log
  // (walt-http-log.json) still records them, so treat cli/logs as secret after this command.
  const response = await ctx.orgClient.post(`/v1/${keyRef}/kms-service-api/keys/generate`, {
    backend: 'aws-rest-api',
    keyType: 'secp256r1',
    config: { auth },
  });

  const awsKeyId = response.data?.key?.id;
  if (!awsKeyId) {
    throw new Error(`AWS key generation for ${keyRef} returned no key id (key type: ${response.data?.key?.type})`);
  }
  const keysFile = process.env.AWS_KMS_KEYS_FILE || join(ctx.cliDir, 'aws-kms-keys.json');
  const recorded: Array<{ keyReference: string }> = existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, 'utf-8')) : [];
  writeFileSync(
    keysFile,
    JSON.stringify(
      [...recorded.filter((k) => k.keyReference !== keyRef), { keyReference: keyRef, awsKeyId, region: auth.region }],
      null,
      2
    )
  );
  ctx.saveJson(`generate-${keyId}-response.json`, { keyReference: keyRef, awsKeyId, status: response.status }, step);

  console.log(`   [OK] AWS KMS key ${awsKeyId} ${response.status === 201 ? 'generated' : 'already present'} (${keyRef})`);
}

/** Schedule deletion of an AWS KMS key through the Enterprise KMS service. AWS keeps it for at least 7 days. */
export async function deleteAwsKmsKey(ctx: CommandContext, keyId: string, prefix: string): Promise<void> {
  ctx.log(`Schedule deletion of AWS KMS key ${keyId}`, prefix);
  const keyRef = kmsKeyRef(ctx, keyId);
  try {
    await ctx.orgClient.delete(`/v1/${keyRef}/kms-service-api/keys/delete`);
    console.log(`   [OK] Deletion scheduled for ${keyRef}`);
  } catch (error: any) {
    if (error.status !== 404) throw error;
    console.log(`   [SKIP] No AWS KMS key at ${keyRef}`);
  }
}

/** Document signer certificate for the AWS KMS key, issued by the CLI IACA */
async function createAwsKmsDocSignerCertificate(ctx: CommandContext): Promise<void> {
  const step = ctx.nextStep();
  ctx.log('Create document signer certificate for the AWS KMS key', PREFIX);

  if (await getStoredCertificatePem(ctx, ISSUER_VARIANT_IDS.awsKmsDocSignerCert)) {
    console.log('   [SKIP] AWS KMS document signer certificate already exists');
    return;
  }

  await createGeneratedCertificate(
    ctx,
    ISSUER_VARIANT_IDS.awsKmsDocSignerCert,
    {
      certificateProfile: CERT_PROFILES.isoDocumentSigner,
      issuerCertificateRef: x509StoreCertificateRef(ctx, CERT_IDS.vicalIacaCert),
      issuerKeyRef: kmsKeyRef(ctx, KEY_IDS.vicalIacaKey),
      subjectKeyRef: kmsKeyRef(ctx, ISSUER_VARIANT_IDS.awsKmsSigningKey),
      subjectDn: isoSubjectDn({ country: 'US', commonName: 'Walt CLI AWS KMS Document Signer' }),
      ...certificateValidityWindow(CERT_VALIDITY_DAYS.documentSigner),
      issuerAlternativeNames: [{ type: 'uri', name: CLI_IACA_IAN_URI }],
      crlDistributionPointUri: CLI_DS_CRL_URI,
    },
    'aws-kms-doc-signer-cert',
    step
  );
  console.log('   [OK] AWS KMS document signer certificate created');
}

/** DID service and store for W3C issuer DIDs (not part of --setup-all) */
export async function ensureDidService(ctx: CommandContext): Promise<void> {
  ctx.log('Create DID service and store', PREFIX);

  for (const svc of [
    { name: RESOURCES.didStore, type: 'did-store' },
    { name: RESOURCES.didService, type: 'did' },
  ]) {
    const { created } = await ctx.tolerantCreate(`${svc.name} service`, () =>
      ctx.orgClient.post(`/v1/${ctx.tenantPath}.${svc.name}/resource-api/services/create`, { type: svc.type })
    );
    if (created) console.log(`   [OK] ${svc.name} created`);
  }

  for (const dependency of [RESOURCES.kms, RESOURCES.didStore]) {
    try {
      await ctx.addServiceDependency(
        `/v1/${ctx.tenantPath}.${RESOURCES.didService}/did-service-api/dids/dependencies/add`,
        `${ctx.tenantPath}.${dependency}`
      );
      console.log(`   [OK] Linked ${dependency} to DID service`);
    } catch (error: any) {
      if (error.status !== 409 && !error.message?.includes('already')) throw error;
      console.log(`   [SKIP] ${dependency} already linked to DID service`);
    }
  }
}

/** did:key for a KMS key, used as the W3C issuer and as the Bitstring status list issuer */
export async function createDid(ctx: CommandContext, keyId: string): Promise<string> {
  ctx.log(`Create did:key for ${keyId}`, PREFIX);
  const response = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.didService}/did-service-api/dids/create/key`,
    { keyReference: kmsKeyRef(ctx, keyId) }
  );
  const did = response.data?.did || response.data?.data?.did || response.data?.id || response.data;
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    throw new Error(`DID creation for ${keyId} returned no DID: ${JSON.stringify(response.data)}`);
  }
  console.log(`   [OK] ${did}`);
  return did;
}

/**
 * The status list a variant's profile points at, signed with the variant's key: by certificate for
 * the token status lists, by the issuer DID for the Bitstring list. Skipped if it already exists.
 */
export async function createVariantStatusList(
  ctx: CommandContext,
  variant: Pick<IssuerVariant, 'format' | 'kms'>,
  dids: Map<string, string>,
  docSignerPems: Map<string, string>
): Promise<void> {
  const keyId = variantSigningKeyId(variant);
  const signer: Record<string, unknown> = variant.format === 'w3c'
    ? { did: dids.get(keyId) }
    : { x5c: [docSignerPems.get(variantDocSignerCertId(variant))] };
  const config = {
    mdoc: { type: 'TokenStatusList', format: 'CWT' },
    sdjwt: { type: 'TokenStatusList', format: 'JWT' },
    w3c: { type: 'BitstringStatusList' },
  }[variant.format];
  await createStatusList(
    ctx,
    variantStatusConfigId(variant),
    { keyReference: kmsKeyRef(ctx, keyId), ...signer, config },
    `${config.type}${'format' in config ? ` ${config.format}` : ''} (${keyId})`
  );
}

async function createStatusList(
  ctx: CommandContext,
  configId: string,
  request: Record<string, unknown>,
  label: string
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Create ${label} status list`, PREFIX);

  const { created } = await ctx.tolerantCreate(`${label} status list`, async () => {
    ctx.saveJson(`create-${configId}-request.json`, request, step);
    const response = await ctx.orgClient.post(
      `/v1/${statusConfigRef(ctx, configId)}/credential-status-service-api/status-credential/create`,
      request
    );
    ctx.saveJson(`create-${configId}-response.json`, response.data, step);
    return response;
  });
  if (created) console.log(`   [OK] ${label} status list created`);
}

/**
 * One of the variant issuers. With the software key it has the same token key and client
 * attestation as the primary issuer2, so the plain `mdoc` variant matches its mdl-profile.
 * [signer] signs the access tokens and, with [signedMetadata], the metadata, which then
 * carries [signer]'s certificate.
 */
export async function createVariantIssuer(
  ctx: CommandContext,
  service: string,
  signer: { keyId: string; certId: string },
  signedMetadata: boolean
): Promise<void> {
  const step = ctx.nextStep();
  ctx.log(`Create issuer ${service} (signed by ${signer.keyId}${signedMetadata ? ', signed metadata' : ''})`, PREFIX);

  const { created } = await ctx.tolerantCreate(`Issuer ${service}`, async () => {
    const request: Record<string, unknown> = {
      type: 'issuer2',
      _id: `${ctx.tenantPath}.${service}`,
      tokenKeyId: kmsKeyRef(ctx, signer.keyId),
      kms: `${ctx.tenantPath}.${RESOURCES.kms}`,
      credentialConfigurations: buildIssuerVariantCredentialConfigurations(),
      sdJwtVcTypeMetadataConfiguration: buildIssuerVariantSdJwtTypeMetadata(),
    };

    if (signedMetadata) {
      request.signedMetadata = {
        signingMethod: {
          type: 'key-reference',
          reference: kmsKeyRef(ctx, signer.keyId),
          x5cReferences: [x509StoreCertificateRef(ctx, signer.certId)],
        },
      };
    }

    if (process.env.ATTESTER_KEY_FILE !== undefined) {
      const attesterKey = ctx.loadKeyFile(process.env.ATTESTER_KEY_FILE || '');
      request.clientAuthenticationConfig = {
        supportedMethods: [
          {
            type: 'client-attestation',
            config: {
              verificationMethod: {
                type: 'static-jwk',
                jwk: { kty: attesterKey.kty, crv: attesterKey.crv, x: attesterKey.x, y: attesterKey.y },
              },
            },
          },
        ],
      };
    }

    ctx.saveJson(`create-${service}-request.json`, request, step);
    const response = await ctx.orgClient.post(
      `/v1/${ctx.tenantPath}.${service}/resource-api/services/create`,
      request
    );
    ctx.saveJson(`create-${service}-response.json`, response.data, step);
    return response;
  });
  if (created) console.log(`   [OK] Issuer ${service} created`);
}

export async function linkIssuerToCredentialStatus(ctx: CommandContext, service: string): Promise<void> {
  try {
    await ctx.addServiceDependency(
      `/v2/${ctx.tenantPath}.${service}/issuer-service-api/dependencies/add`,
      `${ctx.tenantPath}.${RESOURCES.credentialStatus}`
    );
    console.log(`   [OK] Credential status service linked to ${service}`);
  } catch (error: any) {
    if (error.status !== 409 && !error.message?.includes('already')) throw error;
    console.log(`   [SKIP] Credential status service already linked to ${service}`);
  }
}

async function createVariantProfile(
  ctx: CommandContext,
  variant: IssuerVariant,
  certificates: { iacaPem: string; docSignerPems: Map<string, string> },
  dids: Map<string, string>
): Promise<void> {
  const step = ctx.nextStep();
  const target = variantIssuerTarget(ctx.tenantPath, variant);
  const profile = variantProfileName(variant);
  ctx.log(`Create profile for variant ${variant.name}`, PREFIX);

  const { created } = await ctx.tolerantCreate(`Profile ${target}`, async () => {
    const { credentialData, mapping } = buildVariantCredentialData(variant);
    const request: Record<string, unknown> = {
      name: profile,
      credentialConfigurationId: variantCredentialConfigurationId(variant),
      issuerKeyId: kmsKeyRef(ctx, variantSigningKeyId(variant)),
      credentialData,
    };
    if (mapping) request.mapping = mapping;

    if (variant.format === 'mdoc') {
      request.x5Chain = [certificates.docSignerPems.get(variantDocSignerCertId(variant))!, certificates.iacaPem].map(
        (pem) => ({ type: 'pem-encoded-x509-certificate-descriptor', pemEncodedCertificate: pem })
      );
    }
    if (variant.format === 'w3c') {
      request.issuerDid = dids.get(variantSigningKeyId(variant));
    }
    if (variant.status) {
      request.credentialStatus = {
        statusCredentialConfig: statusConfigRef(ctx, variantStatusConfigId(variant)),
        initialStatus: '0x0',
      };
    }

    const logName = `${variantIssuerService(variant)}-${profile}`;
    ctx.saveJson(`create-profile-${logName}-request.json`, request, step);
    const response = await ctx.orgClient.post(`/v2/${target}/issuer-service-api/credentials/profiles`, request);
    ctx.saveJson(`create-profile-${logName}-response.json`, response.data, step);
    return response;
  });
  if (created) console.log(`   [OK] Profile created: ${target}`);
}

/**
 * Set up every variant in ISSUER_VARIANTS (default: mdoc) and write their targets to
 * ISSUER_VARIANTS_FILE as `<variant>\t<format>\t<issuer target>` lines.
 */
export async function runIssuerVariantsSetup(ctx: CommandContext): Promise<void> {
  const variants = parseIssuerVariants(process.env.ISSUER_VARIANTS || 'mdoc');
  console.log(`\n=== Issuer variants setup: ${variants.map((v) => v.name).join(', ')} ===\n`);

  const iacaPem = await requireStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert);
  const docSignerPems = new Map<string, string>([
    [CERT_IDS.docSignerCert, await requireStoredCertificatePem(ctx, CERT_IDS.docSignerCert)],
  ]);

  // The AWS key's certificate is needed by every kms variant: it is the mdoc x5chain, and the x5c of the
  // status lists and signed metadata the AWS key signs.
  if (variants.some((v) => v.kms)) {
    await generateAwsKmsKey(ctx, ISSUER_VARIANT_IDS.awsKmsSigningKey, PREFIX);
    await createAwsKmsDocSignerCertificate(ctx);
    docSignerPems.set(
      ISSUER_VARIANT_IDS.awsKmsDocSignerCert,
      await requireStoredCertificatePem(ctx, ISSUER_VARIANT_IDS.awsKmsDocSignerCert)
    );
  }

  // W3C credentials name their issuer by DID, and so does the Bitstring status list, which is signed with
  // the same key as the credential.
  const dids = new Map<string, string>();
  const w3c = variants.filter((v) => v.format === 'w3c');
  if (w3c.length > 0) {
    await ensureDidService(ctx);
    for (const keyId of new Set(w3c.map(variantSigningKeyId))) dids.set(keyId, await createDid(ctx, keyId));
  }

  // One status list per format and signing key. The software mdoc list already exists from --setup-all.
  const statusLists = new Map<string, IssuerVariant>();
  for (const variant of variants.filter((v) => v.status)) {
    statusLists.set(variantStatusConfigId(variant), variant);
  }
  statusLists.delete(STATUS_CONFIG_IDS.tokenStatusListCwt);
  for (const variant of statusLists.values()) {
    await createVariantStatusList(ctx, variant, dids, docSignerPems);
  }

  // One issuer per signing key and metadata signing. Every variant on a service shares both, so the
  // first one served decides them.
  const services = new Map<string, IssuerVariant[]>();
  for (const variant of variants) {
    const service = variantIssuerService(variant);
    services.set(service, [...(services.get(service) ?? []), variant]);
  }
  for (const [service, served] of services) {
    const signer = { keyId: variantSigningKeyId(served[0]), certId: variantDocSignerCertId(served[0]) };
    await createVariantIssuer(ctx, service, signer, served[0].signedMetadata);
    if (served.some((v) => v.status)) await linkIssuerToCredentialStatus(ctx, service);
  }

  for (const variant of variants) {
    await createVariantProfile(ctx, variant, { iacaPem, docSignerPems }, dids);
  }

  const targetsFile = process.env.ISSUER_VARIANTS_FILE || join(ctx.cliDir, 'issuer-variants.tsv');
  writeFileSync(
    targetsFile,
    variants.map((v) => `${v.name}\t${v.format}\t${variantIssuerTarget(ctx.tenantPath, v)}\n`).join('')
  );
  console.log(`\n[${PREFIX}] ${variants.length} variant(s) ready, targets written to ${targetsFile}`);
}

/**
 * Schedule deletion of the AWS KMS signing key through the Enterprise KMS service.
 * AWS keeps a key for at least 7 days after this; it cannot be used in that time.
 */
export async function runIssuerVariantsTeardown(ctx: CommandContext): Promise<void> {
  await deleteAwsKmsKey(ctx, ISSUER_VARIANT_IDS.awsKmsSigningKey, PREFIX);
}
