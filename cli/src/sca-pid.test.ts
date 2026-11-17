import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScaPidConfig, validateScaPidConfig, scaPidContext, scaProfile, scaTypeMetadata, SCA_PROFILE_IDS } from './sca-pid-config.js';
import { assertConfigurationSubset } from './context.js';
import { assertPolicyOutcome, assertMissingCredential, assertProfilePresentation, type VerificationSession } from './flows/sca-pid.js';
import { trustPolicy } from './commands/setup/sca-pid.js';

const config = () => readScaPidConfig(new URL('../sca-pid.example.json', import.meta.url).pathname);

test('scenario validates every trust role and transport before context or I/O', () => {
  validateScaPidConfig(config());
  const invalid: Array<(c: any) => void> = [
    c => { c.baseUrl = 'http://remote.example.org'; },
    c => { c.baseUrl += '/path'; },
    c => { c.baseUrl = 'https://user:password@example.org'; },
    c => { c.tenant = '../another'; },
    c => { delete c.trust.provider; },
    c => { c.trust.sca = { kind: 'registered' }; },
    c => { c.trust.sca = { kind: 'fixture', sourceFile: '/private/source.xml' }; },
    c => { c.callbackUrl = 'http://remote.example.org/callback'; },
    c => { c.branding.logo = 'http://remote.example.org/logo'; },
    c => { c.token = 'never-in-config'; },
  ];
  for (const mutate of invalid) { const c = config(); mutate(c); assert.throws(() => validateScaPidConfig(c)); }
  const local = { ...config(), baseUrl: 'http://enterprise.localhost:17685', transport: 'local' as const };
  assert.equal(validateScaPidConfig(local).baseUrl, local.baseUrl);
  assert.throws(() => validateScaPidConfig({ ...local, baseUrl: 'http://localhost.example.org:17685' }));
});

test('registered trust requires independent inputs and the role-specific entity type', () => {
  const c = config();
  c.trust.sca = { kind: 'registered', chainFile: 'chain.pem', anchorsFile: 'anchors.pem', sourceFile: 'source.xml', sourceSignerFile: 'signer.pem',
    sourceUrl: 'https://trust.example.org/list', publicKeySha256: 'a'.repeat(64), entityType: 'TRUST_SERVICE_PROVIDER', serviceType: 'http://uri.etsi.org/TrstSvc/Svctype/EAA' };
  validateScaPidConfig(c);
  assert.deepEqual(trustPolicy(c, 'sca'), { policy: 'etsi-trust-list', expectedEntityType: 'TRUST_SERVICE_PROVIDER', expectedServiceType: 'http://uri.etsi.org/TrstSvc/Svctype/EAA', requireAuthenticated: true, allowStaleSource: false });
  c.trust.sca.entityType = 'PID_PROVIDER';
  assert.throws(() => validateScaPidConfig(c), /does not match/);
});

test('scoped scenario context never reads administrator credentials or writes body logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sca-context-'));
  try {
    const ctx = scaPidContext(config(), 'scoped-fixture-token', root);
    assert.equal(ctx.orgClient.getToken(), 'scoped-fixture-token');
    assert.equal(ctx.adminClient.getToken(), null);
    assert.equal(ctx.config.adminPassword, '');
    ctx.saveJson('credential.json', { secret: 'sentinel' });
    ctx.saveRequest('offer.json', 'POST', '/offer', { secret: 'sentinel' });
    ctx.saveResponse('token.json', 200, { secret: 'sentinel' });
    ctx.saveHttpLog();
    assert(!existsSync(ctx.workdir));
    assert.throws(() => scaPidContext(config(), '', root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing resource drift fails before creation while matching server-owned additions are accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sca-resource-'));
  try {
    const ctx = scaPidContext(config(), 'fixture-token', root);
    let writes = 0;
    Object.assign(ctx.orgClient, { get: async () => ({ data: [{ _id: 'example.sca-pid.wallet', type: 'wallet2', configuration: { enabled: false }, createdAt: 'server-owned' }] }),
      post: async () => { writes++; } });
    await ctx.ensureResource('example.sca-pid', 'wallet', { type: 'wallet2' });
    await assert.rejects(ctx.ensureResource('example.sca-pid', 'wallet', { type: 'wallet2', configuration: { enabled: true } }));
    assert.equal(writes, 0);
    assert.throws(() => assertConfigurationSubset({ dependencies: ['a', 'b'] }, { dependencies: ['a'] }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual CLI fails safely without administrator fallback or confidential output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sca-cli-'));
  const input = join(root, 'private-input-sentinel.json');
  try {
    for (const operation of ['setup', 'flow']) {
      for (const [value, token, stage] of [[{ secret: 'private-value-sentinel' }, 'token-sentinel', 'configuration'], [config(), '', 'authentication']] as const) {
        writeFileSync(input, JSON.stringify(value));
        await assert.rejects(promisify(execFile)(process.execPath,
          ['--import', 'tsx', new URL('../walt.ts', import.meta.url).pathname, `--${operation}-sca-pid`, input], {
            timeout: 10_000, env: { ...process.env, SCA_PID_API_TOKEN: token, ADMIN_PASSWORD: 'admin-secret-sentinel' },
          }), (error: any) => {
            assert.equal(error.code, 1);
            assert.equal(error.stdout, '');
            assert.equal(error.stderr.trim(), `SCA/PID ${operation} failed during ${stage}. Check private server diagnostics for details.`);
            return true;
          });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Independent contract: never construct expected evidence from the production inventory.
const EXPECTED_CHECKS = {
  sca: ['dc+sd-jwt/audience-check', 'dc+sd-jwt/kb-jwt_signature', 'dc+sd-jwt/nonce-check',
    'dc+sd-jwt/sd_hash-check', 'dc+sd-jwt/kb-jwt_iat-check', 'dc+sd-jwt/exp-check',
    'dc+sd-jwt/nbf-check', 'dc+sd-jwt/transaction-data-hash-check'],
  pid: ['mso_mdoc/device-auth', 'mso_mdoc/device_key_auth', 'mso_mdoc/transaction-data-hash-check',
    'mso_mdoc/issuer_auth', 'mso_mdoc/issuer_signed_integrity', 'mso_mdoc/mso'],
};

const policies = { sca: [{ policy: 'etsi-trust-list' }, { policy: 'expiration' }, { policy: 'not-before' }, { policy: 'vct-integrity' }, { policy: 'schema' }], pid: [{ policy: 'etsi-trust-list' }] };
function session(): VerificationSession {
  return { status: 'SUCCESSFUL', policy_results: {
    vc_policies: ['pid', 'sca'].flatMap(query_id => ['credential-status', 'signature'].map(policy => ({ query_id, policy: { policy }, success: true }))),
    specific_vc_policies: Object.fromEntries(Object.entries(policies).map(([query_id, ps]) => [query_id, ps.map(policy => ({ query_id, policy, success: true }))])),
  }, presentation_validation_results: Object.fromEntries(Object.entries(EXPECTED_CHECKS).map(([q, checks]) => [q, Object.fromEntries(checks.map(name => [name, { success: true }]))])) };
}

test('policy evidence rejects omitted checks, the wrong credential and cryptographic failure', () => {
  assertPolicyOutcome(session(), policies);
  for (const query of ['sca', 'pid'] as const) {
    for (const check of EXPECTED_CHECKS[query]) {
      const missing = session();
      delete missing.presentation_validation_results![query][check];
      assert.throws(() => assertPolicyOutcome(missing, policies), `Must require ${check}`);
      const failed = session();
      failed.presentation_validation_results![query][check].success = false;
      assert.throws(() => assertPolicyOutcome(failed, policies), `Must reject failed ${check}`);
    }
  }
  const invalid: Array<(s: VerificationSession) => void> = [
    s => { s.policy_results!.vc_policies.pop(); },
    s => { delete s.policy_results!.specific_vc_policies!.pid; },
    s => { s.policy_results!.specific_vc_policies!.sca[0].query_id = 'pid'; },
    s => { s.presentation_validation_results!.pid = {}; },
    s => { s.policy_results!.vc_policies[0].success = false; },
  ];
  for (const mutate of invalid) { const s = session(); mutate(s); assert.throws(() => assertPolicyOutcome(s, policies)); }
});

test('a policy-negative control must reject for exactly the intended reason', () => {
  const s = session();
  s.status = 'FAILED'; s.failure = { type: 'vc_policy_violations' };
  s.policy_results!.specific_vc_policies!.sca[0].success = false;
  assertPolicyOutcome(s, policies, 'sca:etsi-trust-list');
  assert.throws(() => assertPolicyOutcome(s, policies, 'sca:schema'));
  s.policy_results!.vc_policies[0].success = false;
  assert.throws(() => assertPolicyOutcome(s, policies, 'sca:etsi-trust-list'));
});

test('missing-credential controls require DCQL failure and a valid retained presentation', () => {
  for (const omitted of ['sca', 'pid'] as const) {
    const retained = omitted === 'sca' ? 'pid' : 'sca';
    const s: VerificationSession = { status: 'FAILED', failure: { type: 'dcql_fulfillment', failure: { successfully_validated_query_ids: [retained], unsatisfied_sets: [{ options: [['sca', 'pid']] }] } },
      presentation_validation_results: { [retained]: Object.fromEntries(EXPECTED_CHECKS[retained].map(name => [name, { success: true }])) } };
    assertMissingCredential(s, omitted);
    s.presentation_validation_results![retained][EXPECTED_CHECKS[retained][0]].success = false;
    assert.throws(() => assertMissingCredential(s, omitted));
  }
});

function compact(payload: object, disclosures: unknown[] = []) {
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
  return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature~${disclosures.map(encode).join('~')}`;
}

test('profile assertions preserve disclosure and credential-audience boundaries', () => {
  const common = { attestation_legal_category: 'non-qualified-EAA', cnf: { jwk: { kty: 'EC' } }, iat: 10, exp: 100 };
  const user = { ...common, sub: 'example-user' };
  assertProfilePresentation('sca-user', compact(user));
  assert.throws(() => assertProfilePresentation('sca-user', compact({ ...user, aud: 'verifier' })));
  assert.throws(() => assertProfilePresentation('sca-user', compact(user, [['salt', 'sub', 'example-user']])));
  const disclosures = [['salt', 'credential_id', 'urn:uuid:81df8af6-c1ac-4fd9-97d9-4f67512c47bb'], ['salt', 'network', 'mastercard']];
  assertProfilePresentation('sca-card-dpc', compact(common, disclosures));
  for (const name of ['pan', 'bin', 'last_four', 'sub', 'card_id']) assert.throws(() => assertProfilePresentation('sca-card-dpc', compact({ ...common, [name]: 'unexpected' }, disclosures)));
  assert.throws(() => assertProfilePresentation('sca-card-dpc', compact(common, [...disclosures, ['salt', 'card_id', 'hidden']])));
});

test('local SCA metadata uses the standard category and payment schema URNs', () => {
  const root = (scaTypeMetadata(config().branding) as Record<string, any>)['sca-payment-base'];
  assert.equal(root.category, 'urn:eu:europa:ec:eudi:sua:sca');
  const payment = root.transaction_data_types['urn:eudi:sca:payment:1'];
  assert.equal(payment.schema, 'urn:eudi:sca:payment:1');
  assert.equal(payment.schema_uri, undefined);
  assert.deepEqual(payment.claims.map((c: any) => c.path), [
    ['transaction_id'], ['payee', 'name'], ['payee', 'id'], ['currency'], ['amount'],
    ['recurrence', 'frequency'], ['recurrence', 'number'],
  ]);
  assert(payment.claims.every((c: any) => c.display[0].locale === 'en' && c.display[0].label));
  assert.deepEqual(payment.ui_labels.affirmative_action_label, [{ lang: 'en', value: 'Confirm payment' }]);
});

test('branding remains configurable and published parent integrity remains pinned', () => {
  const c = config();
  c.branding = { name: 'Sample Credit Union', background: '#123456', text: '#abcdef', logo: 'https://brand.example.org/logo.svg' };
  const parents = Object.fromEntries(SCA_PROFILE_IDS.map(id => [id, { uri: `https://types.example.org/${id}`, integrity: 'sha256-' + 'A'.repeat(43) + '=' }])) as NonNullable<typeof c.typeParents>;
  validateScaPidConfig({ ...c, typeParents: parents });
  const metadata = scaTypeMetadata(c.branding, parents) as Record<string, any>;
  for (const [id, name] of [['sca-card-dpc', 'Sample Credit Union SCA-card/DPC'], ['sca-user', 'Sample Credit Union SCA-User']] as const) {
    assert.equal(scaProfile(id, c.branding).name, name);
    assert.equal(metadata[id + '-base'].extends, parents[id].uri);
    assert.equal(metadata[id + '-base']['extends#integrity'], parents[id].integrity);
    assert.equal(metadata[id].extends, `{vctBaseURL}/${id}-base`);
    assert.deepEqual(metadata[id + '-base'].display[0], { lang: 'en', name, rendering: { simple: {
      background_color: '#123456', text_color: '#abcdef', logo: { uri: 'https://brand.example.org/logo.svg', alt_text: 'Sample Credit Union' },
    } } });
  }
});
