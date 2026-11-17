/**
 * Wallet Provider trust through a Trust Registry.
 *
 * Issuer2 checks two tokens from the wallet's Wallet Provider: the wallet instance attestation (WIA) on
 * the token request, and the key attestation (KA) on the credential request. With the
 * `x509-trust-registry` method, the Trust Registry linked to the issuer decides both: the provider
 * certificate chain must be listed for one of `expectedEntityTypes` by a fresh source.
 *
 *   --flow-wallet-provider-trust   Scenario matrix (accepted, rejected, server error), PASS/FAIL table.
 *   --demo-wallet-provider-trust   The same feature as a three-act customer demo.
 *
 * Both create their own wallet, wallet provider, issuers and registries, named after one run id, and
 * reuse the tenant's issuer signing key and document signer certificate from `--setup-all`.
 */
import { generateKeyPairSync, KeyObject, sign } from 'crypto';
import { mkdirSync } from 'fs';
import { CommandContext } from '../context.js';
import { CERT_IDS, CREDENTIAL_TYPES, getCredentialType, KEY_IDS, RESOURCES } from '../config.js';
import { setupLogin } from '../commands/setup/index.js';
import {
  certificatePemToDerBase64,
  certificateValidityWindow,
  createGeneratedCertificate,
  getStoredCertificatePem,
  isoSubjectDn,
  kmsKeyRef,
  x509StoreCertificateRef,
} from '../commands/setup/keys.js';
import {
  buildCertificateAnchorLote,
  LOTE_TYPE_EU_PID_PROVIDERS,
  LOTE_TYPE_EU_WALLET_PROVIDERS,
} from '../trust-registry/index.js';

const WALLET_PROVIDER_SERVICE_TYPE = 'urn:waltid:trust-service:wallet-provider';
const KEY_STORAGE = 'iso_18045_high';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type EntityType = 'WALLET_PROVIDER' | 'PID_PROVIDER';

/**
 * What the wallet receipt, or a configuration call, ended with.
 *
 * Wallet2 passes `invalid_client` from the token endpoint through. It does not pass the credential
 * endpoint's error code through: a rejected key attestation (`invalid_proof`) shows as a failure at
 * stage `REQUEST`, after the token request succeeded.
 */
type Outcome =
  | 'ISSUED'
  | 'INVALID_CLIENT'
  | 'CREDENTIAL_REJECTED'
  | 'SERVER_ERROR'
  | 'LIST_REJECTED'
  | 'HTTP_400'
  | 'OTHER';

interface Pki {
  caPem: string;
  leafPem: string;
  otherCaPem: string;
}

interface WalletSetup {
  walletTarget: string;
  holderKeyRef: string;
  providerTarget: string;
}

/** The trust list operator: signs lists as compact JWS (ES256, x5c). */
interface ListSigner {
  privateKey: KeyObject;
  certificatePem: string;
}

interface Run {
  id: string;
  pki: Pki;
  listSigner: ListSigner;
  wallet: WalletSetup;
  docSignerPem: string;
  iacaPem?: string;
}

interface Attempt {
  outcome: Outcome;
  status: number;
  detail: string;
}

interface ScenarioResult {
  id: string;
  title: string;
  expected: Outcome;
  actual: Outcome;
  status: number;
  detail: string;
}

// ============================================================================
// Platform setup: PKI, wallet provider, wallet
// ============================================================================

async function generateKey(ctx: CommandContext, keyId: string): Promise<void> {
  await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.kms}.${keyId}/kms-service-api/keys/generate`,
    { backend: 'jwk', keyType: 'secp256r1' }
  );
}

/** Wallet Provider CA, its leaf (the provider's signing certificate), and an unrelated CA. */
async function createProviderPki(ctx: CommandContext, run: string): Promise<Pki> {
  const step = ctx.nextStep();
  ctx.log('Create the wallet provider PKI (CA + signing certificate) with the X.509 service', 'SETUP');
  const ids = {
    caKey: `${run}-wp-ca-key`,
    leafKey: `${run}-wp-signing-key`,
    otherCaKey: `${run}-other-ca-key`,
    caCert: `${run}-wp-ca-cert`,
    leafCert: `${run}-wp-signing-cert`,
    otherCaCert: `${run}-other-ca-cert`,
  };
  for (const keyId of [ids.caKey, ids.leafKey, ids.otherCaKey]) await generateKey(ctx, keyId);

  const ca = (keyId: string, commonName: string) => ({
    selfSigned: true,
    issuerKeyRef: kmsKeyRef(ctx, keyId),
    subjectKeyRef: kmsKeyRef(ctx, keyId),
    subjectDn: isoSubjectDn({ country: 'AT', commonName, organizationName: 'Demo Wallet Provider' }),
    ...certificateValidityWindow(365),
    basicConstraintsCa: true,
    keyUsage: ['keyCertSign', 'cRLSign'],
  });
  const caPem = await createGeneratedCertificate(
    ctx, ids.caCert, ca(ids.caKey, 'Demo Wallet Provider CA'), 'wallet-provider-ca', step
  );
  const otherCaPem = await createGeneratedCertificate(
    ctx, ids.otherCaCert, ca(ids.otherCaKey, 'Unrelated Wallet Provider CA'), 'other-ca', step
  );
  const leafPem = await createGeneratedCertificate(
    ctx,
    ids.leafCert,
    {
      issuerCertificateRef: x509StoreCertificateRef(ctx, ids.caCert),
      issuerKeyRef: kmsKeyRef(ctx, ids.caKey),
      subjectKeyRef: kmsKeyRef(ctx, ids.leafKey),
      subjectDn: isoSubjectDn({ country: 'AT', commonName: 'Demo Wallet Provider', organizationName: 'Demo Wallet Provider' }),
      ...certificateValidityWindow(365),
      basicConstraintsCa: false,
      keyUsage: ['digitalSignature'],
    },
    'wallet-provider-signing-cert',
    step
  );
  console.log('   [OK] Wallet provider CA, signing certificate and an unrelated CA created');
  return { caPem, leafPem, otherCaPem };
}

/**
 * The list operator's key is generated here and imported into the KMS, so the X.509 service can issue
 * its certificate while this flow signs lists locally.
 */
async function createListSigner(ctx: CommandContext, run: string): Promise<ListSigner> {
  const step = ctx.nextStep();
  ctx.log('Create the trust list operator signing key and certificate', 'SETUP');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyId = `${run}-list-operator-key`;
  await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.kms}.${keyId}/kms-service-api/keys/import/jwk`,
    privateKey.export({ format: 'jwk' })
  );
  const certificatePem = await createGeneratedCertificate(
    ctx,
    `${run}-list-operator-cert`,
    {
      selfSigned: true,
      issuerKeyRef: kmsKeyRef(ctx, keyId),
      subjectKeyRef: kmsKeyRef(ctx, keyId),
      subjectDn: isoSubjectDn({ country: 'AT', commonName: 'Demo Trust List Operator', organizationName: 'Demo Supervisory Body' }),
      ...certificateValidityWindow(365),
      basicConstraintsCa: false,
      keyUsage: ['digitalSignature'],
    },
    'list-operator-cert',
    step
  );
  console.log('   [OK] Trust list operator certificate created');
  return { privateKey, certificatePem };
}

function signList(signer: ListSigner, payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'ES256', x5c: [certificatePemToDerBase64(signer.certificatePem)] })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(input), { key: signer.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/** A Wallet Provider (WIA + KA) and a fresh Wallet2 that uses it during credential receipt. */
async function createWalletWithProvider(ctx: CommandContext, run: string, pki: Pki): Promise<WalletSetup> {
  const step = ctx.nextStep();
  ctx.log('Create a wallet provider and a wallet that uses it', 'SETUP');
  const tenant = ctx.tenantPath;
  const providerTarget = `${tenant}.${run}-wallet-provider`;
  const providerRequest = {
    type: 'wallet-provider',
    signingKeyId: kmsKeyRef(ctx, `${run}-wp-signing-key`),
    issuerIdentifier: 'https://wallet-provider.demo.example',
    profile: 'openid4vci',
    composition: 'wia_ka',
    x5Chain: [{ type: 'pem-encoded-x509-certificate-descriptor', pemEncodedCertificate: pki.leafPem }],
    wia: { ttlSeconds: 3600, walletName: 'Demo Wallet' },
    ka: { ttlSeconds: 3600, keyStorage: [KEY_STORAGE] },
  };
  ctx.saveJson('create-wallet-provider-request.json', providerRequest, step);
  await ctx.orgClient.post(`/v1/${providerTarget}/resource-api/services/create`, providerRequest);

  const walletTarget = `${tenant}.${run}-wallet`;
  const kmsTarget = `${tenant}.${run}-wallet-kms`;
  const holderKeyRef = `${kmsTarget}.holder-key`;
  const initRequest = {
    wallet: {
      createIfNotFound: true,
      target: walletTarget,
      kms: {
        createIfNotFound: true,
        target: kmsTarget,
        key: { createIfNotFound: true, target: holderKeyRef, config: { backend: 'jwk', keyType: 'secp256r1' } },
      },
      didStore: { createIfNotFound: true, target: `${tenant}.${run}-wallet-didstore` },
      didService: {
        createIfNotFound: true,
        target: `${tenant}.${run}-wallet-did-service`,
        dependencies: [kmsTarget, `${tenant}.${run}-wallet-didstore`],
        did: { createIfNotFound: true, target: `${tenant}.${run}-wallet-didstore.holder-did`, type: 'jwk' },
      },
      credentialStore: { createIfNotFound: true, target: `${tenant}.${run}-wallet-credentialstore` },
    },
  };
  ctx.saveJson('init-wallet-request.json', initRequest, step);
  await ctx.orgClient.post(`/v1/${tenant}/resource-api/services/init`, initRequest);
  await ctx.addServiceDependency(`/v2/${walletTarget}/wallet-service-api/dependencies/add`, providerTarget);
  console.log(`   [OK] Wallet ${walletTarget} uses wallet provider ${providerTarget}`);
  return { walletTarget, holderKeyRef, providerTarget };
}

async function prepareRun(ctx: CommandContext): Promise<Run> {
  const id = process.env.WPT_RUN_ID || `wpt-${Date.now().toString(36)}`;
  const docSignerPem = await getStoredCertificatePem(ctx, CERT_IDS.docSignerCert);
  if (!docSignerPem) {
    throw new Error(
      `Document signer certificate '${CERT_IDS.docSignerCert}' not found. Run the default setup first: npx tsx walt.ts`
    );
  }
  const iacaPem = await getStoredCertificatePem(ctx, CERT_IDS.vicalIacaCert);
  console.log(`   Run id: ${id}`);
  const pki = await createProviderPki(ctx, id);
  const listSigner = await createListSigner(ctx, id);
  const wallet = await createWalletWithProvider(ctx, id, pki);
  return { id, pki, listSigner, wallet, docSignerPem, iacaPem };
}

// ============================================================================
// Issuer2, Trust Registry and receipt
// ============================================================================

type VerificationMethod =
  | { type: 'x509-chain'; trustedRootCertificatesPem: string[] }
  | { type: 'x509-trust-registry'; expectedEntityTypes: EntityType[]; requireAuthenticatedSource: boolean };

function registryMethod(types: EntityType[], requireAuthenticatedSource = false): VerificationMethod {
  return { type: 'x509-trust-registry', expectedEntityTypes: types, requireAuthenticatedSource };
}

/** Issuer2 that requires a WIA on the token request and a KA on the credential request. */
async function createIssuer(
  ctx: CommandContext,
  run: Run,
  name: string,
  clientMethod: VerificationMethod,
  keyMethod: VerificationMethod = clientMethod
): Promise<string> {
  const step = ctx.nextStep();
  const credType = CREDENTIAL_TYPES[getCredentialType()];
  const issuerTarget = `${ctx.tenantPath}.${run.id}-${name}-issuer`;
  const request = {
    type: 'issuer2',
    _id: issuerTarget,
    tokenKeyId: kmsKeyRef(ctx, KEY_IDS.issuerSigningKey),
    kms: `${ctx.tenantPath}.${RESOURCES.kms}`,
    clientAuthenticationConfig: {
      supportedMethods: [{ type: 'client-attestation', config: { verificationMethod: clientMethod } }],
    },
    keyAttestationConfig: { verificationMethod: keyMethod },
    credentialConfigurations: {
      [credType.docType]: {
        format: 'mso_mdoc',
        doctype: credType.docType,
        scope: credType.docType,
        credential_signing_alg_values_supported: [-7, -9],
        cryptographic_binding_methods_supported: ['cose_key'],
        proof_types_supported: {
          jwt: {
            proof_signing_alg_values_supported: ['ES256'],
            key_attestations_required: { key_storage: [KEY_STORAGE] },
          },
        },
      },
    },
  };
  ctx.saveJson(`${name}-create-issuer-request.json`, request, step);
  await ctx.orgClient.post(`/v1/${issuerTarget}/resource-api/services/create`, request);

  const x5Chain = [run.docSignerPem, run.iacaPem]
    .filter((pem): pem is string => Boolean(pem))
    .map(pem => ({ type: 'pem-encoded-x509-certificate-descriptor', pemEncodedCertificate: pem }));
  await ctx.orgClient.post(`/v2/${issuerTarget}.pid/issuer-service-api/credentials/profiles`, {
    name: 'pid',
    credentialConfigurationId: credType.docType,
    issuerKeyId: kmsKeyRef(ctx, KEY_IDS.issuerSigningKey),
    x5Chain,
    credentialData: { [credType.namespace]: credType.credentialData },
  });
  return issuerTarget;
}

interface Listing {
  /** One trusted entity per certificate. */
  certificatesPem: string[];
  /** Entity names, by position; defaults to "Demo Wallet Provider". */
  names?: string[];
  loteType?: string;
  /** Defaults to one year from now; `null` omits it. */
  nextUpdate?: Date | null;
  /** Sign the list as the run's list operator and load it with REQUIRE_AUTHENTICATED. */
  signed?: boolean;
}

function walletProviderList(sourceId: string, listing: Listing): object {
  return buildCertificateAnchorLote(
    sourceId,
    'AT',
    listing.certificatesPem.map((certificatePem, index) => ({
      id: `${sourceId}-entity-${index}`,
      legalName: listing.names?.[index] ?? 'Demo Wallet Provider',
      country: 'AT',
      serviceName: 'Wallet provider',
      serviceType: WALLET_PROVIDER_SERVICE_TYPE,
      certificatePem,
    })),
    listing.loteType ?? LOTE_TYPE_EU_WALLET_PROVIDERS,
    listing.nextUpdate === undefined ? new Date(Date.now() + 365 * DAY_MS) : listing.nextUpdate
  );
}

async function createRegistry(ctx: CommandContext, run: Run, name: string): Promise<string> {
  const registryTarget = `${ctx.tenantPath}.${run.id}-${name}-registry`;
  await ctx.orgClient.post(`/v1/${registryTarget}/resource-api/services/create`, { type: 'trust-registry' });
  return registryTarget;
}

/** Load (or replace, same `sourceId`) a list in the registry. Returns the load result. */
async function publishList(
  ctx: CommandContext,
  run: Run,
  registryTarget: string,
  sourceId: string,
  listing: Listing
): Promise<any> {
  const step = ctx.nextStep();
  const lote = walletProviderList(sourceId, listing);
  ctx.saveJson(`${sourceId}-lote.json`, lote, step);
  const request = listing.signed
    ? {
        sourceId,
        content: signList(run.listSigner, lote),
        acceptancePolicy: 'REQUIRE_AUTHENTICATED',
        trustedSignerCertificates: [run.listSigner.certificatePem],
      }
    : { sourceId, content: JSON.stringify(lote), acceptancePolicy: 'ALLOW_UNSIGNED' };
  const response = await ctx.orgClient.post(`/v1/${registryTarget}/trust-registry-api/sources/load`, request);
  ctx.saveJson(`${sourceId}-load-response.json`, response.data, step);
  return response.data;
}

async function linkRegistry(ctx: CommandContext, issuerTarget: string, registryTarget: string): Promise<void> {
  await ctx.addServiceDependency(`/v2/${issuerTarget}/issuer-service-api/dependencies/add`, registryTarget);
}

/** What the registry itself says about the provider's signing certificate. */
async function registryView(ctx: CommandContext, registryTarget: string, leafPem: string): Promise<any> {
  const response = await ctx.orgClient.post(`/v1/${registryTarget}/trust-registry-api/resolve/certificate-chain`, {
    certificateChainPemOrDer: [leafPem],
    expectedEntityType: 'WALLET_PROVIDER',
  });
  return response.data;
}

function credentialIdsOf(data: any): string[] {
  if (Array.isArray(data?.credentialIds)) return data.credentialIds;
  if (Array.isArray(data)) {
    return data.flatMap(result => (Array.isArray(result?.stored) ? result.stored.map((s: any) => s?._id) : []));
  }
  return [];
}

function errorDetail(body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const description = text.match(/error_description\\?":\\?"([^"\\]+)/)?.[1];
  const message = description || text.match(/"message":"([^"]+)/)?.[1] || text;
  return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

function classify(status: number, body: unknown): Outcome {
  if (status >= 200 && status < 300) return credentialIdsOf(body).length > 0 ? 'ISSUED' : 'OTHER';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text.includes('invalid_client')) return 'INVALID_CLIENT';
  if (text.includes('"stage":"REQUEST"')) return 'CREDENTIAL_REJECTED';
  if (status === 400) return 'HTTP_400';
  if (status >= 500) return 'SERVER_ERROR';
  return 'OTHER';
}

/** Create a pre-authorized offer and let the wallet receive it. Never throws for HTTP errors. */
async function receive(ctx: CommandContext, run: Run, issuerTarget: string, label: string): Promise<Attempt> {
  const step = ctx.nextStep();
  const offer = await ctx.orgClient.post(`/v2/${issuerTarget}.pid/issuer-service-api/credentials/offers`, {
    authMethod: 'PRE_AUTHORIZED',
  });
  const request = { offerUrl: offer.data.credentialOffer, keyReference: run.wallet.holderKeyRef };
  ctx.saveJson(`${label}-wallet-receive-request.json`, request, step);
  let status: number;
  let body: unknown;
  try {
    const response = await ctx.orgClient.post(
      `/v2/${run.wallet.walletTarget}/wallet-service-api/credentials/receive/pre-authorized`,
      request
    );
    status = response.status;
    body = response.data;
  } catch (error: any) {
    if (!error.status) throw error;
    status = error.status;
    body = error.response?.data;
  }
  ctx.saveJson(`${label}-wallet-receive-response.json`, { status, body }, step);
  const outcome = classify(status, body);
  const detail = outcome === 'ISSUED' ? `${credentialIdsOf(body).length} credential(s) stored` : errorDetail(body);
  return { outcome, status, detail };
}

/** Run a configuration call that is expected to fail; never throws for HTTP errors. */
async function attempt(ctx: CommandContext, label: string, call: () => Promise<unknown>): Promise<Attempt> {
  const step = ctx.nextStep();
  try {
    await call();
    ctx.saveJson(`${label}-response.json`, { status: 'ok' }, step);
    return { outcome: 'OTHER', status: 200, detail: 'accepted' };
  } catch (error: any) {
    if (!error.status) throw error;
    ctx.saveJson(`${label}-response.json`, { status: error.status, body: error.response?.data }, step);
    return {
      outcome: classify(error.status, error.response?.data),
      status: error.status,
      detail: errorDetail(error.response?.data),
    };
  }
}

// ============================================================================
// Test matrix
// ============================================================================

interface Scenario {
  id: string;
  title: string;
  expected: Outcome;
  run: (ctx: CommandContext, run: Run) => Promise<Attempt>;
}

/** Issuer with `x509-trust-registry`, its own registry holding `listing`, linked after creation. */
async function registryIssuance(
  ctx: CommandContext,
  run: Run,
  name: string,
  listing: Listing,
  options: { clientTypes?: EntityType[]; keyTypes?: EntityType[]; requireAuthenticatedSource?: boolean } = {}
): Promise<{ issuerTarget: string; registryTarget: string; result: Attempt }> {
  const clientTypes = options.clientTypes ?? ['WALLET_PROVIDER'];
  const keyTypes = options.keyTypes ?? clientTypes;
  const issuerTarget = await createIssuer(
    ctx, run, name,
    registryMethod(clientTypes, options.requireAuthenticatedSource),
    registryMethod(keyTypes, options.requireAuthenticatedSource)
  );
  const registryTarget = await createRegistry(ctx, run, name);
  const load = await publishList(ctx, run, registryTarget, `${run.id}-${name}`, listing);
  if (!load.success) {
    return { issuerTarget, registryTarget, result: { outcome: 'LIST_REJECTED', status: 0, detail: `list not loaded: ${load.error}` } };
  }
  await linkRegistry(ctx, issuerTarget, registryTarget);
  return { issuerTarget, registryTarget, result: await receive(ctx, run, issuerTarget, name) };
}

function scenarios(): Scenario[] {
  return [
    {
      id: 'baseline',
      title: 'x509-chain with the provider CA as root (no registry)',
      expected: 'ISSUED',
      run: async (ctx, run) => {
        const issuer = await createIssuer(ctx, run, 'baseline', {
          type: 'x509-chain',
          trustedRootCertificatesPem: [run.pki.caPem],
        });
        return receive(ctx, run, issuer, 'baseline');
      },
    },
    {
      id: 'leaf-listed',
      title: 'Registry lists the provider signing certificate as WALLET_PROVIDER',
      expected: 'ISSUED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'leaf-listed', { certificatesPem: [run.pki.leafPem] })).result,
    },
    {
      id: 'ca-listed',
      title: 'Registry lists the provider CA only (leaf-only x5c, path built to the CA)',
      expected: 'ISSUED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'ca-listed', { certificatesPem: [run.pki.caPem] })).result,
    },
    {
      id: 'unlisted',
      title: 'Registry lists only an unrelated CA',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'unlisted', { certificatesPem: [run.pki.otherCaPem] })).result,
    },
    {
      id: 'wrong-type',
      title: 'Provider listed on a PID Providers list, issuer expects WALLET_PROVIDER',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'wrong-type', {
          certificatesPem: [run.pki.caPem],
          loteType: LOTE_TYPE_EU_PID_PROVIDERS,
        })).result,
    },
    {
      id: 'expired',
      title: 'List expired (nextUpdate yesterday)',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'expired', {
          certificatesPem: [run.pki.caPem],
          nextUpdate: new Date(Date.now() - DAY_MS),
        })).result,
    },
    {
      id: 'stale',
      title: 'List stale (nextUpdate in 12 hours)',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'stale', {
          certificatesPem: [run.pki.caPem],
          nextUpdate: new Date(Date.now() + 12 * HOUR_MS),
        })).result,
    },
    {
      id: 'fresh-25h',
      title: 'List still fresh (nextUpdate in 25 hours)',
      expected: 'ISSUED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'fresh-25h', {
          certificatesPem: [run.pki.caPem],
          nextUpdate: new Date(Date.now() + 25 * HOUR_MS),
        })).result,
    },
    {
      id: 'no-next-update',
      // ETSI TS 119 602 requires NextUpdate, so the registry refuses the list before any decision.
      title: 'List without nextUpdate is refused at load',
      expected: 'LIST_REJECTED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'no-next-update', {
          certificatesPem: [run.pki.caPem],
          nextUpdate: null,
        })).result,
    },
    {
      id: 'require-authenticated',
      title: 'requireAuthenticatedSource=true, list loaded unsigned',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'require-auth', { certificatesPem: [run.pki.caPem] }, {
          requireAuthenticatedSource: true,
        })).result,
    },
    {
      id: 'signed-authenticated',
      title: 'requireAuthenticatedSource=true, list signed by a trusted list operator',
      expected: 'ISSUED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'signed-auth', { certificatesPem: [run.pki.caPem], signed: true }, {
          requireAuthenticatedSource: true,
        })).result,
    },
    {
      id: 'ka-only',
      title: 'WIA accepts PID_PROVIDER too, KA only WALLET_PROVIDER, provider on a PID list',
      expected: 'CREDENTIAL_REJECTED',
      run: async (ctx, run) =>
        (await registryIssuance(ctx, run, 'ka-only', {
          certificatesPem: [run.pki.caPem],
          loteType: LOTE_TYPE_EU_PID_PROVIDERS,
        }, {
          clientTypes: ['WALLET_PROVIDER', 'PID_PROVIDER'],
          keyTypes: ['WALLET_PROVIDER'],
        })).result,
    },
    {
      id: 'no-registry',
      title: 'x509-trust-registry configured, no registry linked',
      expected: 'SERVER_ERROR',
      run: async (ctx, run) => {
        const issuer = await createIssuer(ctx, run, 'no-registry', registryMethod(['WALLET_PROVIDER']));
        return receive(ctx, run, issuer, 'no-registry');
      },
    },
    {
      // Reuses the issuer from 'no-registry'; keep both in this order.
      id: 'link-later',
      title: 'Same issuer, registry linked afterwards (no restart, no reconfiguration)',
      expected: 'ISSUED',
      run: async (ctx, run) => {
        const issuer = `${ctx.tenantPath}.${run.id}-no-registry-issuer`;
        const registry = await createRegistry(ctx, run, 'link-later');
        await publishList(ctx, run, registry, `${run.id}-link-later`, { certificatesPem: [run.pki.caPem] });
        await linkRegistry(ctx, issuer, registry);
        return receive(ctx, run, issuer, 'link-later');
      },
    },
    {
      // The 'no-registry' issuer has a registry since 'link-later'.
      id: 'second-registry',
      title: 'Linking a second registry to the same issuer',
      expected: 'HTTP_400',
      run: async (ctx, run) => {
        const issuer = `${ctx.tenantPath}.${run.id}-no-registry-issuer`;
        const second = await createRegistry(ctx, run, 'second');
        return attempt(ctx, 'second-registry', () => linkRegistry(ctx, issuer, second));
      },
    },
    {
      id: 'delisted',
      title: 'Provider removed from the list (same sourceId reloaded without it)',
      expected: 'INVALID_CLIENT',
      run: async (ctx, run) => {
        const { issuerTarget, registryTarget, result } = await registryIssuance(
          ctx, run, 'delisted', { certificatesPem: [run.pki.caPem] }
        );
        if (result.outcome !== 'ISSUED') {
          return { ...result, detail: `precondition (listed) failed: ${result.detail}` };
        }
        await publishList(ctx, run, registryTarget, `${run.id}-delisted`, { certificatesPem: [run.pki.otherCaPem] });
        return receive(ctx, run, issuerTarget, 'delisted-after');
      },
    },
    {
      id: 'empty-types',
      title: 'Create an issuer with expectedEntityTypes []',
      expected: 'HTTP_400',
      run: async (ctx, run) =>
        attempt(ctx, 'empty-types', () => createIssuer(ctx, run, 'empty-types', registryMethod([]))),
    },
  ];
}

function printTable(results: ScenarioResult[]): void {
  const width = Math.max(...results.map(r => r.id.length));
  console.log('\n  Result  Scenario' + ' '.repeat(Math.max(0, width - 8)) + '  Expected             Actual');
  console.log('  ' + '-'.repeat(width + 60));
  for (const r of results) {
    const verdict = r.expected === r.actual ? 'PASS' : 'FAIL';
    console.log(
      `  [${verdict}] ${r.id.padEnd(width)}  ${r.expected.padEnd(20)} ${r.actual} (HTTP ${r.status})`
    );
    if (verdict === 'FAIL' || process.env.VERBOSE === 'true') console.log(`         ${r.detail}`);
  }
}

export async function flowWalletProviderTrust(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  Flow: Wallet Provider trust (x509-trust-registry)');
  console.log('========================================\n');
  mkdirSync(ctx.workdir, { recursive: true });
  const results: ScenarioResult[] = [];
  const only = process.env.WPT_SCENARIOS?.split(',').map(s => s.trim()).filter(Boolean);

  try {
    await setupLogin(ctx);
    const run = await prepareRun(ctx);
    for (const scenario of scenarios()) {
      if (only && !only.includes(scenario.id)) continue;
      ctx.log(`${scenario.id}: ${scenario.title}`, 'SCENARIO');
      let outcome: Attempt;
      try {
        outcome = await scenario.run(ctx, run);
      } catch (error: any) {
        outcome = {
          outcome: 'OTHER',
          status: error.status ?? 0,
          detail: `setup failed: ${error.message} ${error.response?.data ? errorDetail(error.response.data) : ''}`,
        };
      }
      const pass = outcome.outcome === scenario.expected;
      console.log(`   [${pass ? 'PASS' : 'FAIL'}] expected ${scenario.expected}, got ${outcome.outcome} (HTTP ${outcome.status})`);
      results.push({ id: scenario.id, title: scenario.title, expected: scenario.expected, actual: outcome.outcome, status: outcome.status, detail: outcome.detail });
    }
    ctx.saveJson('wallet-provider-trust-results.json', { runId: run.id, results }, ctx.nextStep());
    printTable(results);
    const failed = results.filter(r => r.expected !== r.actual);
    if (failed.length > 0) throw new Error(`${failed.length} of ${results.length} scenarios failed`);
    console.log(`\n  PASS - ${results.length} scenarios\n`);
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}

// ============================================================================
// Customer demo
// ============================================================================

function describeDecision(decision: any): string {
  const entity = decision?.matchedEntity;
  if (!decision?.matchedSource) return `${decision?.decision ?? 'UNKNOWN'}, the provider is on no loaded list`;
  const parts = [decision.decision];
  if (entity?.entityType) parts.push(`"${entity.legalName}" as ${entity.entityType}`);
  parts.push(`list "${decision.matchedSource.sourceId}" is ${decision.sourceFreshness}`);
  return parts.join(', ');
}

function describeReceipt(result: Attempt): string {
  switch (result.outcome) {
    case 'ISSUED':
      return `Credential issued (${result.detail})`;
    case 'INVALID_CLIENT':
      return 'Issuer refused the wallet (invalid_client)';
    default:
      return `${result.outcome} (HTTP ${result.status}): ${result.detail}`;
  }
}

async function demoAct(
  ctx: CommandContext,
  run: Run,
  issuerTarget: string,
  registryTarget: string,
  title: string,
  narrative: string,
  expected: Outcome
): Promise<boolean> {
  console.log(`\n--- ${title} ---`);
  console.log(`    ${narrative}`);
  const view = await registryView(ctx, registryTarget, run.pki.leafPem);
  console.log(`    Trust Registry says:  ${describeDecision(view)}`);
  const result = await receive(ctx, run, issuerTarget, title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  const ok = result.outcome === expected;
  console.log(`    Wallet receives PID:  ${describeReceipt(result)}  ${ok ? '[as expected]' : `[UNEXPECTED, wanted ${expected}]`}`);
  return ok;
}

export async function flowWalletProviderTrustDemo(ctx: CommandContext): Promise<void> {
  console.log('\n==============================================================');
  console.log('  Demo: Issue only to wallets from listed wallet providers');
  console.log('==============================================================');
  console.log('  A PID issuer accepts a wallet only if a trust list, such as the EU');
  console.log('  Wallet Providers List, names the wallet\'s provider. The issuer holds');
  console.log('  no provider certificates. It asks its Trust Registry on every request,');
  console.log('  and accepts only lists signed by the list operator it trusts.\n');
  mkdirSync(ctx.workdir, { recursive: true });

  try {
    await setupLogin(ctx);
    const run = await prepareRun(ctx);
    const issuerTarget = await createIssuer(ctx, run, 'demo', registryMethod(['WALLET_PROVIDER'], true));
    const registryTarget = await createRegistry(ctx, run, 'demo');
    const sourceId = `${run.id}-eu-wallet-providers`;
    const otherProvider = { certificatesPem: [run.pki.otherCaPem], names: ['Other Wallet Provider'], signed: true };
    const bothProviders = {
      certificatesPem: [run.pki.otherCaPem, run.pki.caPem],
      names: ['Other Wallet Provider', 'Demo Wallet Provider'],
      signed: true,
    };
    await publishList(ctx, run, registryTarget, sourceId, otherProvider);
    await linkRegistry(ctx, issuerTarget, registryTarget);
    console.log(`\n  Issuer:          ${issuerTarget}`);
    console.log(`  Trust Registry:  ${registryTarget}  (list "${sourceId}")`);
    console.log(`  Wallet:          ${run.wallet.walletTarget}  (provider: Demo Wallet Provider)`);

    const outcomes = [
      await demoAct(ctx, run, issuerTarget, registryTarget,
        'Act 1: Unknown provider',
        'The Wallet Providers List names another provider, not "Demo Wallet Provider".',
        'INVALID_CLIENT'),
    ];

    await publishList(ctx, run, registryTarget, sourceId, bothProviders);
    outcomes.push(await demoAct(ctx, run, issuerTarget, registryTarget,
      'Act 2: Provider listed',
      'The list operator signs and publishes a new version that adds the provider CA.',
      'ISSUED'));

    await publishList(ctx, run, registryTarget, sourceId, otherProvider);
    outcomes.push(await demoAct(ctx, run, issuerTarget, registryTarget,
      'Act 3: Provider removed',
      'The provider is taken off the list, for example after a security incident.',
      'INVALID_CLIENT'));

    console.log('\n  The issuer configuration never changed: trust followed the list.');
    if (outcomes.some(ok => !ok)) throw new Error('The demo did not behave as expected');
    console.log('\n  Demo complete.\n');
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}
