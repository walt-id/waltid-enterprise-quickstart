import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandContext } from '../context.js';
import { ScaPidConfig, ScaProfileId, SCA_PROFILE_IDS, SIGNER_ROLES, scaProfile, PID, holderKeyReference } from '../sca-pid-config.js';
import { RESOURCES } from '../config.js';
import { SCA_PID_SAMPLE } from '../fixtures/sca-pid.js';
import { trustPolicy } from '../commands/setup/sca-pid.js';

type Policy = { policy: string; [key: string]: unknown };
const PRESENTATION_CHECKS = {
  sca: ['audience-check', 'kb-jwt_signature', 'nonce-check', 'sd_hash-check', 'kb-jwt_iat-check', 'exp-check', 'nbf-check', 'transaction-data-hash-check'].map(id => `dc+sd-jwt/${id}`),
  pid: ['device-auth', 'device_key_auth', 'transaction-data-hash-check', 'issuer_auth', 'issuer_signed_integrity', 'mso'].map(id => `mso_mdoc/${id}`),
};
type PolicyResult = { query_id: string; policy: Policy; success: boolean; error?: string; result?: any };
export interface VerificationSession {
  status: string;
  failure?: { type: string; failure?: { successfully_validated_query_ids: string[]; unsatisfied_sets: unknown[] } };
  presented_credentials?: Record<string, any[]>;
  presented_presentations?: Record<string, unknown[]>;
  policy_results?: { vc_policies: PolicyResult[]; specific_vc_policies?: Record<string, PolicyResult[]> };
  presentation_validation_results?: Record<string, Record<string, { success: boolean }>>;
}

/** A policy-negative result is useful only when both presentations are valid. */
export function assertPolicyOutcome(session: VerificationSession, expected: Record<string, Policy[]>, failure?: string): void {
  assert.equal(session.status, failure ? 'FAILED' : 'SUCCESSFUL');
  if (failure) assert.equal(session.failure?.type, 'vc_policy_violations');
  const results = session.policy_results;
  assert(results, 'Policy results are missing');
  assert.deepEqual(results.vc_policies.map(p => `${p.query_id}:${p.policy.policy}`).sort(), ['pid:credential-status', 'pid:signature', 'sca:credential-status', 'sca:signature']);
  const validations = session.presentation_validation_results ?? {};
  assert.deepEqual(Object.keys(validations).sort(), ['pid', 'sca']);
  for (const query of ['sca', 'pid'] as const) assertPresentationChecks(validations[query], query);
  const specific = results.specific_vc_policies ?? {};
  assert.deepEqual(Object.keys(specific).sort(), Object.keys(expected).sort());
  for (const [query, policies] of Object.entries(expected)) {
    assert.deepEqual(specific[query].map(p => p.policy.policy).sort(), policies.map(p => p.policy).sort());
    assert(specific[query].every(p => p.query_id === query), 'Policy ran against the wrong credential');
  }
  const all = [...results.vc_policies, ...Object.values(specific).flat()];
  assert.deepEqual(all.filter(p => p.success !== true).map(p => `${p.query_id}:${p.policy.policy}`), failure ? [failure] : []);
}

export function assertMissingCredential(session: VerificationSession, omitted: 'sca' | 'pid'): void {
  const retained = omitted === 'sca' ? 'pid' : 'sca';
  assert.equal(session.status, 'FAILED');
  assert.equal(session.failure?.type, 'dcql_fulfillment');
  assert.deepEqual(session.failure.failure?.successfully_validated_query_ids, [retained]);
  assert.deepEqual(session.failure.failure?.unsatisfied_sets, [{ options: [['sca', 'pid']] }]);
  assertPresentationChecks(session.presentation_validation_results?.[retained], retained);
}

function assertPresentationChecks(checks: Record<string, { success: boolean }> | undefined, query: 'sca' | 'pid'): void {
  assert(checks, 'Presentation checks are missing');
  for (const name of PRESENTATION_CHECKS[query]) assert.equal(checks[name]?.success, true, `Required presentation check failed or missing: ${name}`);
  assert(Object.values(checks).every(p => p.success), 'Presentation cryptography was not successful');
}

export function assertProfilePresentation(id: ScaProfileId, compact: string): Record<string, string> {
  const [jwt, ...parts] = compact.split('~');
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const disclosures = parts.filter(p => p && !p.includes('.')).map(p => JSON.parse(Buffer.from(p, 'base64url').toString()));
  assert.equal(payload.attestation_legal_category, 'non-qualified-EAA');
  assert(!('aud' in payload), 'Credential audience must not be confused with presentation audience');
  assert(payload.cnf?.jwk, 'Credential is missing its holder key');
  assert(Number.isInteger(payload.iat), 'Credential issue time must be numeric');
  // Issuer2 rounds generated iat to UTC days and exp to hours for unlinkability.
  assert(payload.exp > payload.iat && payload.exp - payload.iat <= 26 * 3600, 'Credential lifetime exceeds the two-hour profile plus issuance-time rounding');
  if (id === 'sca-user') {
    assert.equal(disclosures.length, 0);
    assert(!payload._sd?.length && typeof payload.sub === 'string' && payload.sub.length > 0);
  } else {
    for (const key of ['sub', 'credential_id', 'network', 'card_id', 'pan', 'bin', 'last_four']) assert(!(key in payload));
    assert.deepEqual(disclosures.map(d => d[1]).sort(), ['credential_id', 'network']);
    assert.equal(disclosures.find(d => d[1] === 'network')[2], SCA_PID_SAMPLE.card.network);
    assert.match(disclosures.find(d => d[1] === 'credential_id')[2], /^urn:uuid:[0-9a-f-]{36}$/i);
  }
  return payload.cnf.jwk;
}

export function payment(kind: 'immediate' | 'recurring') {
  return { type: 'urn:eudi:sca:payment:1', credential_ids: ['sca'], require_cryptographic_holder_binding: true, transaction_data_hashes_alg: ['sha-256'],
    payload: { transaction_id: randomUUID(),
      ...SCA_PID_SAMPLE.payment,
      ...(kind === 'recurring' && { recurrence: SCA_PID_SAMPLE.recurrence }) } };
}

export interface ScaAuthorizationRequest {
  wallet: string;
  requestUrl: string;
  credentialId: string;
  referenceToken: string;
}
/** The authority resolves and authenticates the request itself; request inputs are not factor evidence. */
export type ScaAuthorizer = (request: ScaAuthorizationRequest) => Promise<Record<string, string>>;

export async function flowScaPid(ctx: CommandContext, config: ScaPidConfig, authorize?: ScaAuthorizer) {
  const api = ctx.orgClient, target = ctx.tenantPath;
  const wallet = `/v2/${target}.${RESOURCES.wallet}/wallet-service-api`;
  const verifier = `/v2/${target}.${RESOURCES.verifier2}/verifier-service-api`;
  const issuer = `/v2/${target}.${RESOURCES.issuer}/issuer-service-api`;
  const callbackToken = process.env.SCA_PID_CALLBACK_TOKEN;
  if (config.callbackUrl) assert(callbackToken?.trim() && !/[\r\n]/.test(callbackToken), 'Configured callbacks require a bearer token');
  const notifications = config.callbackUrl ? { webhook: { url: config.callbackUrl, bearer_token: callbackToken } } : undefined;
  const metadata = (await api.get(`/.well-known/openid-credential-issuer${issuer}/openid4vci`, { auth: false })).data;
  const outcomes: Array<{ profile: ScaProfileId; presentation: string; controls: number; payments: string[] }> = [];
  const holders = new Set<string>();

  for (const id of SCA_PROFILE_IDS) {
    const profile = scaProfile(id, config.branding);
    const vct = metadata.credential_configurations_supported?.[id]?.vct;
    assert(typeof vct === 'string' && new URL(vct).protocol.startsWith('http'), 'SCA type metadata is missing');
    const ids: Record<string, string> = {}, issuanceSessions: Record<string, string> = {};
    const holderRefs = { sca: holderKeyReference(target, id, 'sca'), pid: holderKeyReference(target, id, 'pid') };
    for (const [role, profileId] of [['sca', id], ['pid', 'pid']] as const) {
      const offer = (await api.post(`/v2/${target}.${RESOURCES.issuer}.${profileId}/issuer-service-api/credentials/offers`, {
        authMethod: 'PRE_AUTHORIZED', ...(notifications && { runtimeOverrides: { notifications } }),
      })).data;
      const offerUri = new URL(new URL(offer.credentialOffer).searchParams.get('credential_offer_uri')!);
      assert.equal(offerUri.origin, ctx.orgBaseUrl);
      const issuanceId = offerUri.searchParams.get('id');
      assert(issuanceId, 'Issuance session identifier is missing');
      issuanceSessions[role] = issuanceId;
      if (role === 'sca' && id === SCA_PROFILE_IDS[0]) {
        const document = (await api.get(offerUri.pathname + offerUri.search, { auth: false })).data;
        const grant = document.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
        const unauthenticated = await api.request('POST', `${issuer}/openid4vci/token`, new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': grant['pre-authorized_code'],
        }).toString(), { auth: false, contentType: 'application/x-www-form-urlencoded', allow: [401] });
        assert.equal(unauthenticated.status, 401);
        assert.equal(unauthenticated.data.error, 'invalid_client');
        assert(JSON.stringify(unauthenticated.data).includes('Client authentication is required for this endpoint'));
      }
      const received = (await api.post(`${wallet}/credentials/receive/pre-authorized`, { offerUrl: offer.credentialOffer, keyReference: holderRefs[role] })).data;
      assert.equal(received.credentialIds?.length, 1);
      ids[role] = received.credentialIds[0];
    }
    const received = (await api.get(`${wallet}/credentials/${ids.sca}`)).data;
    assert.equal(received.metadata?.credentialDisplay?.[0]?.name, profile.name);
    const policies: Record<string, Policy[]> = {
      sca: [trustPolicy(config, 'sca'), { policy: 'expiration', requireField: true }, { policy: 'not-before', requireField: true }, { policy: 'vct-integrity' }, { policy: 'schema', schema: profile.schema }],
      pid: [trustPolicy(config, 'pid')],
    };
    async function createSession(specific = policies, transactionData?: ReturnType<typeof payment>[]) {
      const session = (await api.post(`${verifier}/verification-session/create`, {
        flow_type: 'cross_device', keyReference: `${target}.${RESOURCES.kms}.verifier`, ...(transactionData && { openid: { transactionData } }),
        core_flow: { signed_request: true, encrypted_request: true, encrypted_response: true,
          dcql_query: { credentials: [
            { id: 'sca', format: 'dc+sd-jwt', meta: { vct_values: [vct] }, claims: profile.claims.map(k => ({ path: [k] })) },
            { id: 'pid', format: 'mso_mdoc', meta: { doctype_value: PID }, claims: ['family_name', 'given_name'].map(k => ({ path: [PID, k] })) },
          ], credential_sets: [{ options: [['sca', 'pid']], required: true }] },
          policies: { vc_policies: [{ policy: 'signature' }, { policy: 'credential-status', argument: { discriminator: 'ietf', value: 0 } }], specific_vc_policies: specific },
          ...(notifications && { notifications }),
        },
      })).data as { sessionId: string; fullAuthorizationRequestUrl: string };
      assert(session.sessionId);
      const requestUri = new URL(session.fullAuthorizationRequestUrl).searchParams.get('request_uri');
      assert(requestUri && new URL(requestUri).origin === ctx.orgBaseUrl, 'Presentation request has an unexpected origin');
      return session;
    }
    type Session = Awaited<ReturnType<typeof createSession>>;
    const info = async (s: Session): Promise<VerificationSession> => (await api.get(`${verifier.replace('/verifier-service-api', '')}.${s.sessionId}/verifier-service-api/verification-session/info`)).data.session;
    async function build(s: Session, grants?: Record<string, string>, expectedError?: string) {
      const result = await api.request('POST', `${wallet}/credentials/present/build-vp-token`, {
        requestUrl: s.fullAuthorizationRequestUrl, keyReference: holderRefs.pid, selectedCredentialIds: { sca: [ids.sca], pid: [ids.pid] }, ...(grants && { scaAuthorizations: grants }),
      }, expectedError ? { allow: [400] } : {});
      if (expectedError) {
        assert.equal(result.status, 400);
        assert(JSON.stringify(result.data).includes(expectedError), 'Presentation failed for an unexpected reason');
        return '';
      }
      assert.deepEqual(Object.keys(JSON.parse(result.data.vpToken)).sort(), ['pid', 'sca']);
      return result.data.vpToken as string;
    }
    async function send(s: Session, token: string) {
      await api.request('POST', `${wallet}/credentials/present/send-response`, { requestUrl: s.fullAuthorizationRequestUrl, vpToken: token }, { allow: [400] });
      return info(s);
    }
    const positive = await createSession();
    const token = await build(positive);
    const issuedPayload = JSON.parse(Buffer.from(JSON.parse(token).sca[0].split('.')[1], 'base64url').toString());
    assert(issuedPayload.exp > Date.now() / 1000 && issuedPayload.exp <= Date.now() / 1000 + 7200, 'Issued credential expiry is outside its two-hour profile');
    const holder = assertProfilePresentation(id, JSON.parse(token).sca[0]);
    const holderIdentity = JSON.stringify([holder.kty, holder.crv, holder.x, holder.y]);
    assert(!holders.has(holderIdentity), 'Each SCA profile needs a distinct holder key');
    holders.add(holderIdentity);
    const result = await send(positive, token);
    assertPolicyOutcome(result, policies);
    assert.deepEqual(Object.keys(result.presented_credentials ?? {}).sort(), ['pid', 'sca']);
    for (const role of ['sca', 'pid']) {
      const trust = result.policy_results!.specific_vc_policies![role].find(
        p => p.policy.policy === 'etsi-trust-list')!.result;
      assert(trust.trusted && trust.authenticity === 'AUTHENTICATED' && trust.sourceFreshness === 'FRESH');
    }
    const integrity = result.policy_results!.specific_vc_policies!.sca.find(
      p => p.policy.policy === 'vct-integrity')!.result;
    assert.equal(integrity.vct_integrity_value_verified, true);
    if (!config.typeParents) assert.equal(integrity.resolved_types.length, 3);
    for (const name of ['expiration', 'not-before']) assert.equal(result.policy_results!.specific_vc_policies!.sca.find(p => p.policy.policy === name)!.result.claim_checked, true);
    let controls = 0;
    for (const omitted of ['sca', 'pid'] as const) {
      const session = await createSession();
      const partial = JSON.parse(await build(session));
      delete partial[omitted];
      assertMissingCredential(await send(session, JSON.stringify(partial)), omitted);
      controls++;
    }
    const wrongSchema = structuredClone(policies);
    wrongSchema.sca.find(p => p.policy === 'schema')!.schema = { type: 'object', required: ['missing-required-claim'] };
    const schemaSession = await createSession(wrongSchema);
    assertPolicyOutcome(await send(schemaSession, await build(schemaSession)), wrongSchema, 'sca:schema');
    controls++;
    for (const role of ['sca', 'pid']) {
      const changed = structuredClone(policies);
      changed[role][0].expectedEntityType = role === 'sca' ? 'PID_PROVIDER' : 'WALLET_PROVIDER';
      const session = await createSession(changed);
      assertPolicyOutcome(await send(session, await build(session)), changed, `${role}:etsi-trust-list`);
      controls++;
    }
    const original = await createSession();
    const replayToken = await build(original);
    const other = await createSession();
    const replay = await send(other, replayToken);
    assert.equal(replay.status, 'FAILED');
    assert.equal(replay.failure?.type, 'presentation_validation');
    assert.deepEqual(Object.entries(replay.presentation_validation_results!.sca).filter(([, p]) => !p.success).map(([k]) => k), ['dc+sd-jwt/nonce-check']);
    assert.deepEqual(Object.entries(replay.presentation_validation_results!.pid).filter(([, p]) => !p.success).map(([k]) => k), ['mso_mdoc/device-auth']);
    controls++;

    for (const role of ['sca', 'pid']) {
      const setStatus = (status: string) => api.put(`/v1/${target}.${RESOURCES.credentialStatus}.${role}-list/credential-status-service-api/status-credential/status/update`, {
        session: `${target}.${RESOURCES.issuer}.${issuanceSessions[role]}`, status,
      });
      async function waitForStatus(revoked: boolean) {
        const deadline = Date.now() + 10_000;
        do {
          const session = await createSession();
          const result = await send(session, await build(session));
          const observedRevoked = result.status === 'FAILED';
          assertPolicyOutcome(result, policies, observedRevoked ? `${role}:credential-status` : undefined);
          if (observedRevoked) assert.equal(result.policy_results!.vc_policies.find(
                p => p.query_id === role && p.policy.policy === 'credential-status')!.error,
            'Status validation failed: expected one of [0], but got 1');
          if (observedRevoked === revoked) return;
          await delay(250);
        } while (Date.now() < deadline);
        throw new Error('Credential status did not become observable before the deadline');
      }
      try {
        await setStatus('0x1');
        await waitForStatus(true);
        controls++;
      } finally { await setStatus('0x0'); }
      await waitForStatus(false);
    }
    const payments: string[] = [];
    for (const kind of ['immediate', 'recurring'] as const) {
      const session = await createSession(policies, [payment(kind)]);
      await build(session, undefined, 'TS12 requires authentication evidence for this presentation');
      if (authorize) {
        const grants = await authorize({ wallet: `${target}.${RESOURCES.wallet}`, requestUrl: session.fullAuthorizationRequestUrl, credentialId: ids.sca, referenceToken: token });
        assertPolicyOutcome(await send(session, await build(session, grants)), policies);
        payments.push(`${kind}:successful`);
      } else payments.push(`${kind}:authentication-required`);
    }
    outcomes.push({ profile: id, presentation: 'successful', controls, payments });
  }
  const denied = await api.request('POST', `/v2/${target}.${RESOURCES.issuer}.sca-card-dpc/issuer-service-api/credentials/offers`, { authMethod: 'PRE_AUTHORIZED' }, { auth: false, allow: [401, 403] });
  assert([401, 403].includes(denied.status));
  return { outcome: 'successful', profiles: outcomes, metadata: config.typeParents ? 'configured-parent' : 'fixture',
    trust: Object.fromEntries(SIGNER_ROLES.map(role => [role, config.trust[role].kind])),
    callbacks: notifications ? 'configured; receiver acceptance required' : 'not-configured',
    retained: 'Issued example credentials and holder keys remain in the configured wallet' };
}
