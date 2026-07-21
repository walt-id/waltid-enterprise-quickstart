import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename } from 'path';
import { CommandContext } from '../context.js';
import {
  CERT_IDS,
  defaultWalletDidReference,
  defaultWalletKeyReference,
  KEY_IDS,
  MDL_DOC_TYPE,
  RESOURCES,
} from '../config.js';
import { setupLogin, linkVerifier2ToTrustRegistry } from '../commands/setup/index.js';
import { clearWalletCredentials, runWalletPresent } from '../commands/run.js';
import {
  listTrustRegistrySources,
  loadTrustSource,
  requireSuccessfulLoad,
  resolveTrustCertificateChain,
  TrustDecision,
  buildCertificateAnchorLote,
  MDL_ISSUER_SERVICE_TYPE,
} from '../trust-registry/index.js';

const SOURCE_ID = 'trust-list-local-iaca';
const PROFILE_ID = 'mdl-profile-trust-list-assurance';

async function retrieveCertificate(ctx: CommandContext, certificateId: string): Promise<string> {
  const response = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.x509Store}.${certificateId}/x509-store-api/certificates`
  );
  const pem = response.data.data?.pem || response.data.certificatePem || response.data.pem;
  if (!pem) throw new Error(`Certificate '${certificateId}' did not contain PEM data`);
  return pem;
}

async function ensureAnchorSource(ctx: CommandContext, iacaPem: string): Promise<string> {
  const sources = await listTrustRegistrySources(ctx);
  const existing = sources.find(source => source.sourceId === SOURCE_ID)
    || sources.find(source => source.sourceId === 'journey-iaca-local');
  if (existing) {
    console.log(`   [SKIP] Reusing IACA trust source: ${existing.sourceId}`);
    return existing.sourceId;
  }

  const step = ctx.nextStep();
  const lote = buildCertificateAnchorLote(SOURCE_ID, 'US', [{
    id: 'trust-list-test-iaca',
    legalName: 'Trust List Test IACA',
    country: 'US',
    serviceName: 'mDL issuing',
    serviceType: MDL_ISSUER_SERVICE_TYPE,
    certificatePem: iacaPem,
  }]);
  const request = {
    sourceId: SOURCE_ID,
    content: JSON.stringify(lote),
    acceptancePolicy: 'ALLOW_UNSIGNED' as const,
  };
  ctx.saveJson('trust-list-anchor-lote.json', lote, step);
  ctx.saveJson('trust-list-anchor-load-request.json', request, step);
  const result = requireSuccessfulLoad(await loadTrustSource(ctx, request));
  ctx.saveJson('trust-list-anchor-load-response.json', result, step);
  console.log(`   [OK] Registry anchor loaded (${result.identitiesLoaded || 0} identities)`);
  return SOURCE_ID;
}

function requirePathDecision(decision: TrustDecision, expectedSourceId: string): void {
  if (decision.decision !== 'TRUSTED') {
    throw new Error(`Expected TRUSTED chain decision, got ${decision.decision}`);
  }
  if (decision.matchedSource?.sourceId !== expectedSourceId) {
    throw new Error(`Expected source '${expectedSourceId}', got '${decision.matchedSource?.sourceId || '<none>'}'`);
  }
  if (!decision.evidence.some(evidence => evidence.type === 'CERTIFICATE_PATH')) {
    throw new Error('Trusted decision did not contain CERTIFICATE_PATH evidence');
  }
}

async function testDirectChainResolution(
  ctx: CommandContext,
  leafPem: string,
  unrelatedPem: string,
  expectedSourceId: string
): Promise<void> {
  const step = ctx.nextStep();
  const request = {
    certificateChainPemOrDer: [leafPem],
    expectedEntityType: 'PID_PROVIDER',
    expectedServiceType: MDL_ISSUER_SERVICE_TYPE,
  };
  ctx.saveJson('trust-list-resolve-chain-request.json', request, step);
  const decision = await resolveTrustCertificateChain(ctx, request);
  ctx.saveJson('trust-list-resolve-chain-response.json', decision, step);
  requirePathDecision(decision, expectedSourceId);
  console.log('   [PASS] Leaf-only chain resolved to registry-owned IACA');

  const negativeStep = ctx.nextStep();
  const negativeRequest = {
    ...request,
    certificateChainPemOrDer: [unrelatedPem],
  };
  ctx.saveJson('trust-list-resolve-unrelated-request.json', negativeRequest, negativeStep);
  const negative = await resolveTrustCertificateChain(ctx, negativeRequest);
  ctx.saveJson('trust-list-resolve-unrelated-response.json', negative, negativeStep);
  if (negative.decision !== 'NOT_TRUSTED') {
    throw new Error(`Expected unrelated certificate to be NOT_TRUSTED, got ${negative.decision}`);
  }
  console.log('   [PASS] Unrelated certificate correctly rejected');
}

function decodeProtectedHeader(jws: string): any {
  const parts = jws.trim().split('.');
  if (parts.length !== 3 || parts.some(part => !part)) {
    throw new Error('Expected compact JWS with protected-header.payload.signature');
  }
  return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}

function embeddedSignerAsPem(jws: string): string {
  const x5c = decodeProtectedHeader(jws).x5c;
  if (!Array.isArray(x5c) || typeof x5c[0] !== 'string') {
    throw new Error('Compact JWS protected header does not contain x5c[0]');
  }
  const lines = x5c[0].match(/.{1,64}/g)?.join('\n') || x5c[0];
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

function certificateSha256(pem: string): string {
  const der = Buffer.from(
    pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, ''),
    'base64'
  );
  return createHash('sha256').update(der).digest('hex');
}

async function testSignedLote(ctx: CommandContext): Promise<void> {
  const jwsPath = process.env.TRUST_LIST_SIGNED_LOTE_FILE;
  if (!jwsPath) {
    console.log('   [SKIP] TRUST_LIST_SIGNED_LOTE_FILE is not configured');
    return;
  }
  if (!existsSync(jwsPath)) throw new Error(`Signed LoTE file not found: ${jwsPath}`);

  const jws = readFileSync(jwsPath, 'utf8').trim();
  const signerPath = process.env.TRUST_LIST_SIGNER_CERT_FILE;
  let signerPem: string;
  if (signerPath) {
    if (!existsSync(signerPath)) throw new Error(`Signer certificate not found: ${signerPath}`);
    signerPem = readFileSync(signerPath, 'utf8');
  } else if (process.env.TRUST_LIST_ALLOW_EMBEDDED_SIGNER_TEST_PIN === 'true') {
    console.log('   [WARN] Using embedded x5c signer as an explicit functional-test pin');
    console.log('          This does not model independent production signer trust.');
    signerPem = embeddedSignerAsPem(jws);
  } else {
    throw new Error(
      'Set TRUST_LIST_SIGNER_CERT_FILE, or explicitly enable TRUST_LIST_ALLOW_EMBEDDED_SIGNER_TEST_PIN=true for a functional test'
    );
  }

  const sourceId = process.env.TRUST_LIST_SIGNED_SOURCE_ID || 'signed-lote-source';
  const existing = (await listTrustRegistrySources(ctx)).find(source => source.sourceId === sourceId);
  if (!existing) {
    const step = ctx.nextStep();
    const request = {
      sourceId,
      content: jws,
      acceptancePolicy: 'REQUIRE_AUTHENTICATED' as const,
      trustedSignerCertificates: [signerPem],
    };
    ctx.saveJson('trust-list-signed-lote-load-request.json', request, step);
    const result = requireSuccessfulLoad(await loadTrustSource(ctx, request));
    ctx.saveJson('trust-list-signed-lote-load-response.json', result, step);
  }

  const source = (await listTrustRegistrySources(ctx)).find(item => item.sourceId === sourceId);
  if (!source) throw new Error(`Signed source '${sourceId}' was not listed after loading`);
  if (source.assurance.authenticityState !== 'AUTHENTICATED' || !source.assurance.accepted) {
    throw new Error(
      `Expected authenticated signed source, got ${source.assurance.authenticityState} ` +
      `(accepted=${source.assurance.accepted})`
    );
  }
  if (source.metadata?.signatureFormat !== 'JWS_COMPACT') {
    throw new Error(`Expected JWS_COMPACT metadata, got ${source.metadata?.signatureFormat || '<none>'}`);
  }
  if (source.metadata?.signerCertificateSha256 !== certificateSha256(signerPem)) {
    throw new Error('Signed source signer fingerprint does not match the configured certificate pin');
  }
  console.log(`   [PASS] Signed LoTE validated: ${basename(jwsPath)} (${source.metadata.signatureAlgorithm})`);

  const negativeStep = ctx.nextStep();
  const negativeRequest = {
    sourceId: `untrusted-signer-${Date.now()}`,
    content: jws,
    acceptancePolicy: 'REQUIRE_AUTHENTICATED' as const,
  };
  ctx.saveJson('trust-list-missing-signer-load-request.json', negativeRequest, negativeStep);
  const negative = await loadTrustSource(ctx, negativeRequest);
  ctx.saveJson('trust-list-missing-signer-load-response.json', negative, negativeStep);
  if (negative.success || !negative.error?.includes('trusted signer certificate')) {
    throw new Error(`Expected missing signer trust failure, got: ${JSON.stringify(negative)}`);
  }
  console.log('   [PASS] Signed LoTE without independent signer trust correctly rejected');
}

async function recreateLeafOnlyProfile(ctx: CommandContext, leafPem: string): Promise<string> {
  const profilePath = `${ctx.tenantPath}.${RESOURCES.issuer}.${PROFILE_ID}`;
  try {
    await ctx.orgClient.delete(`/v2/${profilePath}/issuer-service-api/credentials/profiles`);
  } catch (error: any) {
    if (error.status !== 404) throw error;
  }

  const request = {
    name: PROFILE_ID,
    credentialConfigurationId: MDL_DOC_TYPE,
    issuerKeyId: `${ctx.tenantPath}.${RESOURCES.kms}.${KEY_IDS.issuerSigningKey}`,
    x5Chain: [{
      type: 'pem-encoded-x509-certificate-descriptor',
      pemEncodedCertificate: leafPem,
    }],
    credentialData: {
      'org.iso.18013.5.1': {
        family_name: 'Trust List',
        given_name: 'Root Omitted',
        birth_date: '1990-01-01',
        issue_date: '2026-07-17',
        expiry_date: '2029-01-01',
        issuing_country: 'US',
        issuing_authority: 'Trust List Test DMV',
        document_number: 'TRUSTLIST01',
        un_distinguishing_sign: 'USA',
      },
    },
  };
  const step = ctx.nextStep();
  ctx.saveJson('trust-list-create-profile-request.json', request, step);
  const response = await ctx.orgClient.post(
    `/v2/${profilePath}/issuer-service-api/credentials/profiles`,
    request
  );
  ctx.saveJson('trust-list-create-profile-response.json', response.data, step);
  return profilePath;
}

function extractCredentialIds(receiveResponse: any): string[] {
  if (!Array.isArray(receiveResponse)) return [];
  return receiveResponse.flatMap(result =>
    Array.isArray(result?.stored)
      ? result.stored.map((stored: any) => stored?._id).filter((id: unknown) => typeof id === 'string')
      : []
  );
}

async function testVerifierIntegration(
  ctx: CommandContext,
  leafPem: string,
  expectedSourceId: string
): Promise<void> {
  const profilePath = await recreateLeafOnlyProfile(ctx, leafPem);
  await clearWalletCredentials(ctx);

  let step = ctx.nextStep();
  const offerResponse = await ctx.orgClient.post(
    `/v2/${profilePath}/issuer-service-api/credentials/offers`,
    { authMethod: 'PRE_AUTHORIZED' }
  );
  ctx.saveJson('trust-list-offer-response.json', offerResponse.data, step);
  const offerUrl = offerResponse.data.credentialOffer;
  if (!offerUrl) throw new Error('Trust-list test profile did not return a credential offer');

  step = ctx.nextStep();
  const receiveRequest = {
    offerUrl,
    keyReference: ctx.ctx.walletKeyRef,
    runPolicies: false,
    useClientAttestation: true,
  };
  ctx.saveJson('trust-list-wallet-receive-request.json', receiveRequest, step);
  const receiveResponse = await ctx.orgClient.post(
    `/v2/${ctx.tenantPath}.${RESOURCES.wallet}/wallet-service-api/credentials/receive/pre-authorized`,
    receiveRequest
  );
  ctx.saveJson('trust-list-wallet-receive-response.json', receiveResponse.data, step);
  const credentialIds = extractCredentialIds(receiveResponse.data);
  if (credentialIds.length === 0) throw new Error('No trust-list test credential was stored in the wallet');

  step = ctx.nextStep();
  const sessionRequest = {
    flow_type: 'cross_device',
    core_flow: {
      dcql_query: {
        credentials: [{
          id: 'trust_list_mdl',
          format: 'mso_mdoc',
          meta: { doctype_value: MDL_DOC_TYPE },
          claims: [
            { path: ['org.iso.18013.5.1', 'family_name'] },
            { path: ['org.iso.18013.5.1', 'given_name'] },
          ],
        }],
      },
      policies: {
        vc_policies: [
          { policy: 'signature' },
          {
            policy: 'etsi-trust-list',
            expectedEntityType: 'PID_PROVIDER',
            expectedServiceType: MDL_ISSUER_SERVICE_TYPE,
            allowStaleSource: false,
            requireAuthenticated: false,
          },
        ],
      },
    },
  };
  ctx.saveJson('trust-list-verification-session-request.json', sessionRequest, step);
  const sessionResponse = await ctx.orgClient.post(
    `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}/verifier2-service-api/verification-session/create`,
    sessionRequest
  );
  ctx.saveJson('trust-list-verification-session-response.json', sessionResponse.data, step);
  ctx.ctx.sessionId = sessionResponse.data.sessionId;
  ctx.ctx.requestUrl = sessionResponse.data.bootstrapAuthorizationRequestUrl;
  if (!ctx.ctx.sessionId || !ctx.ctx.requestUrl) throw new Error('Could not create trust-list verification session');

  await runWalletPresent(ctx, credentialIds);

  step = ctx.nextStep();
  const infoResponse = await ctx.orgClient.get(
    `/v1/${ctx.tenantPath}.${RESOURCES.verifier2}.${ctx.ctx.sessionId}/verifier2-service-api/verification-session/info`
  );
  ctx.saveJson('trust-list-final-session-info.json', infoResponse.data, step);
  const session = infoResponse.data.session;
  if (session?.status !== 'SUCCESSFUL') {
    throw new Error(`Expected trust-list session SUCCESSFUL, got ${session?.status || '<empty>'}`);
  }
  const policies = session.policyResults?.vc_policies || [];
  const trustPolicy = policies.find((entry: any) =>
    entry.policy?.policy === 'etsi-trust-list' || entry.policy?.id === 'etsi-trust-list'
  );
  if (!trustPolicy?.success) {
    throw new Error(`ETSI trust-list policy did not succeed: ${trustPolicy?.error || 'result missing'}`);
  }
  if (trustPolicy.result?.matchedSource?.sourceId !== expectedSourceId) {
    throw new Error(`ETSI policy matched unexpected source: ${trustPolicy.result?.matchedSource?.sourceId || '<none>'}`);
  }
  console.log('   [PASS] Verifier2 resolved root-omitted credential through linked Trust Registry');
}

export async function flowTrustListAssurance(ctx: CommandContext): Promise<void> {
  console.log('\n========================================');
  console.log('  Flow: Trust List Assurance');
  console.log('========================================\n');
  mkdirSync(ctx.workdir, { recursive: true });

  try {
    await setupLogin(ctx);
    await linkVerifier2ToTrustRegistry(ctx);
    ctx.ctx.walletKeyRef ||= defaultWalletKeyReference(ctx.tenantPath);
    ctx.ctx.walletDid ||= defaultWalletDidReference(ctx.tenantPath);

    const iacaPem = await retrieveCertificate(ctx, CERT_IDS.vicalIacaCert);
    const leafPem = await retrieveCertificate(ctx, CERT_IDS.docSignerCert);
    const unrelatedPem = ctx.loadPemFile('vical-signer-cert.pem');

    console.log('\n--- A. Registry-owned certificate path ---');
    const anchorSourceId = await ensureAnchorSource(ctx, iacaPem);
    await testDirectChainResolution(ctx, leafPem, unrelatedPem, anchorSourceId);

    console.log('\n--- B. Signed LoTE authenticity ---');
    await testSignedLote(ctx);

    console.log('\n--- C. Verifier2 linked-service integration ---');
    await testVerifierIntegration(ctx, leafPem, anchorSourceId);

    console.log('\n========================================');
    console.log('  PASS - Trust list assurance checks complete');
    console.log('========================================\n');
  } finally {
    ctx.saveHttpLog();
    console.log(`Logs saved to: ${ctx.workdir}`);
  }
}
