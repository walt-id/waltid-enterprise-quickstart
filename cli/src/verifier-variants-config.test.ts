import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestSigner,
  buildVerificationSessionRequest,
  buildVerifierCredentialQuery,
  buildVerifierPolicies,
  parseVerifierVariants,
  verifierQueryId,
  verifierSessionRequestFileName,
} from './verifier-variants-config.js';

const software: RequestSigner = { keyReference: 't.kms.software', clientId: 'x509_hash:soft', x5c: ['leaf', 'iaca'] };
const awsKms: RequestSigner = { keyReference: 't.kms.aws', clientId: 'x509_hash:aws', x5c: ['awsleaf', 'iaca'] };
const VCT = 'http://waltid.example/.well-known/vct/v2/t.issuer/issuer-service-api/openid4vci/identity_sdjwt_status';

function session(variant: string): any {
  const [parsed] = parseVerifierVariants(variant);
  return buildVerificationSessionRequest(parsed, { sdJwtVct: VCT, signers: { software, awsKms } });
}

test('parseVerifierVariants canonicalises toggle order and drops duplicates', () => {
  const variants = parseVerifierVariants(' mdoc , sdjwt+kms+signed+status, SDJWT+status+signed+kms ,w3c+trust');
  assert.deepEqual(variants.map((v) => v.name), ['mdoc', 'sdjwt+status+signed+kms', 'w3c+trust']);
});

test('parseVerifierVariants rejects unknown toggles and meaningless combinations', () => {
  assert.throws(() => parseVerifierVariants('pdf'), /Unknown verifier variant format/);
  assert.throws(() => parseVerifierVariants('mdoc+vical'), /Unknown verifier variant toggle/);
  assert.throws(() => parseVerifierVariants('mdoc+kms'), /needs \+signed/);
  assert.throws(() => parseVerifierVariants('sdjwt+portrait'), /needs the mdoc format/);
  assert.throws(() => parseVerifierVariants(' , '), /No verifier variants/);
});

test('every variant verifies the signature; status and trust are scoped to the variant query', () => {
  const [plain] = parseVerifierVariants('w3c');
  assert.deepEqual(buildVerifierPolicies(plain), { vc_policies: [{ policy: 'signature' }] });

  const [w3c] = parseVerifierVariants('w3c+status+trust');
  const policies = buildVerifierPolicies(w3c) as any;
  const specific = policies.specific_vc_policies[verifierQueryId(w3c)];
  assert.deepEqual(specific.map((p: any) => p.policy), ['credential-status', 'etsi-trust-list']);
  // W3C carries a BitstringStatusList entry, which the ietf discriminator cannot read.
  assert.equal(specific[0].argument.discriminator, 'w3c');

  const [sdjwt] = parseVerifierVariants('sdjwt+status');
  assert.equal((buildVerifierPolicies(sdjwt) as any).specific_vc_policies.loadtest_sdjwt[0].argument.discriminator, 'ietf');
});

test('the query id the policies are keyed by is the id of the DCQL query', () => {
  for (const name of ['mdoc+status', 'sdjwt+trust', 'w3c+status']) {
    const body = session(name);
    const queryId = body.core_flow.dcql_query.credentials[0].id;
    assert.ok(body.core_flow.policies.specific_vc_policies[queryId], `${name}: policies not keyed by ${queryId}`);
  }
});

test('DCQL queries target the seeded credential of each format', () => {
  const [portrait] = parseVerifierVariants('mdoc+portrait');
  const mdoc = buildVerifierCredentialQuery(portrait) as any;
  assert.equal(mdoc.format, 'mso_mdoc');
  assert.ok(mdoc.claims.some((c: any) => c.path.at(-1) === 'portrait'));

  const [sdjwt] = parseVerifierVariants('sdjwt');
  assert.deepEqual((buildVerifierCredentialQuery(sdjwt, VCT) as any).meta, { vct_values: [VCT] });
  assert.throws(() => buildVerifierCredentialQuery(sdjwt), /needs the vct/);
});

test('an unsigned, unencrypted session carries no key, client id or certificate', () => {
  const body = session('mdoc');
  assert.equal(body.keyReference, undefined);
  assert.equal(body.core_flow.signed_request, undefined);
  assert.equal(body.core_flow.clientId, undefined);
  assert.equal(body.core_flow.x5c, undefined);
});

test('a signed session names its key at the top level and its certificate in core_flow', () => {
  const soft = session('sdjwt+signed');
  assert.equal(soft.keyReference, software.keyReference);
  assert.equal(soft.core_flow.keyReference, undefined);
  assert.equal(soft.core_flow.signed_request, true);
  assert.equal(soft.core_flow.clientId, software.clientId);
  assert.deepEqual(soft.core_flow.x5c, software.x5c);

  const kms = session('sdjwt+signed+kms');
  assert.equal(kms.keyReference, awsKms.keyReference);
  assert.equal(kms.core_flow.clientId, awsKms.clientId);
});

test('an encrypted-only session has a key reference but stays unsigned', () => {
  const body = session('mdoc+encrypted');
  assert.equal(body.keyReference, software.keyReference);
  assert.equal(body.core_flow.encrypted_response, true);
  assert.equal(body.core_flow.signed_request, undefined);
  assert.equal(body.core_flow.clientId, undefined);
});

test('a kms variant without the AWS signer fails instead of falling back to the software key', () => {
  const [variant] = parseVerifierVariants('mdoc+signed+kms');
  assert.throws(() => buildVerificationSessionRequest(variant, { signers: { software } }), /AWS KMS request signer/);
});

test('session request file names are unique per variant', () => {
  const names = parseVerifierVariants('mdoc, mdoc+status, mdoc+signed+kms').map(verifierSessionRequestFileName);
  assert.deepEqual(names, ['mdoc.json', 'mdoc-status.json', 'mdoc-signed-kms.json']);
});
