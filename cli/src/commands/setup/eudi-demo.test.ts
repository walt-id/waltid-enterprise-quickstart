import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLiveRegistrarCredentialCreateItem,
  credentialMetaForFormat,
  decodeFlexibleBase64,
  extractCreatedId,
  extractCreatedIds,
  isAuthorizationPendingError,
  isoDateOnly,
  mdocNamespaceForFormat,
  normalizeEntitlement,
  normalizeIdentifierType,
  parseClaimPath,
  parseClaimPaths,
  shouldRegisterProvidedAttestations,
} from '../../eudi-wrp.js';

test('extractCreatedId reads nested registrar id maps', () => {
  const response = {
    code: 201,
    data: { 'Law new ids:': [313] },
    message: 'Law created successfully',
    status: 'success',
  };
  assert.equal(extractCreatedId(response, 'law'), 313);
});

test('extractCreatedIds keeps policy create order', () => {
  const response = {
    code: 201,
    data: { 'Policy new ids:': [11, 22] },
    status: 'success',
  };
  assert.deepEqual(extractCreatedIds(response), [11, 22]);
});

test('extractCreatedId uses the mislabeled intended-use ids field', () => {
  const response = {
    status: 'success',
    data: { 'Credentials ids': [42] },
  };
  assert.equal(extractCreatedId(response, 'intended use'), 42);
});

test('extractCreatedIds accepts the older data array envelope', () => {
  assert.deepEqual(extractCreatedIds({ data: [7, 8], message: 'ok' }), [7, 8]);
});

test('extractCreatedId does not treat HTTP code as an entity id', () => {
  assert.throws(
    () => extractCreatedId({ code: 201, data: {}, status: 'success' }, 'law'),
    /No law ID returned/
  );
});

test('isAuthorizationPendingError treats registrar 500/400 as pending', () => {
  assert.equal(
    isAuthorizationPendingError(new Error('WRP API error 500: {"error":"400"}')),
    true
  );
  assert.equal(isAuthorizationPendingError(new Error('not found')), true);
  assert.equal(isAuthorizationPendingError(new Error('WRP API error 403: forbidden')), false);
});

test('parseClaimPath wraps mdoc attributes with the doctype namespace', () => {
  assert.deepEqual(
    parseClaimPath('given_name', 'eu.europa.ec.eudi.pid.1'),
    ['eu.europa.ec.eudi.pid.1', 'given_name']
  );
  assert.deepEqual(
    parseClaimPath('["org.iso.18013.5.1","family_name"]'),
    ['org.iso.18013.5.1', 'family_name']
  );
  assert.deepEqual(parseClaimPath('given_name'), ['given_name']);
  assert.deepEqual(parseClaimPath('address.street'), ['address', 'street']);
});

test('parseClaimPaths splits comma-separated env values', () => {
  assert.deepEqual(
    parseClaimPaths('given_name, family_name', 'eu.europa.ec.eudi.pid.1'),
    [
      ['eu.europa.ec.eudi.pid.1', 'given_name'],
      ['eu.europa.ec.eudi.pid.1', 'family_name'],
    ]
  );
});

test('buildLiveRegistrarCredentialCreateItem stringifies meta and claim paths', () => {
  const item = buildLiveRegistrarCredentialCreateItem(
    'mso_mdoc',
    [
      ['eu.europa.ec.eudi.pid.1', 'given_name'],
      ['eu.europa.ec.eudi.pid.1', 'family_name'],
    ],
    { doctype_value: 'eu.europa.ec.eudi.pid.1' }
  );
  assert.deepEqual(item, {
    format: 'mso_mdoc',
    meta: '{"doctype_value":"eu.europa.ec.eudi.pid.1"}',
    claims: [
      { path: '["eu.europa.ec.eudi.pid.1","given_name"]' },
      { path: '["eu.europa.ec.eudi.pid.1","family_name"]' },
    ],
  });
});

test('credentialMetaForFormat uses live jwt_vc meta by default shape', () => {
  assert.deepEqual(credentialMetaForFormat('jwt_vc', {}), {
    name: 'PID Credential',
    version: '1.0',
  });
  assert.deepEqual(credentialMetaForFormat('mso_mdoc', { doctype: 'eu.europa.ec.eudi.pid.1' }), {
    doctype_value: 'eu.europa.ec.eudi.pid.1',
  });
  assert.deepEqual(credentialMetaForFormat('dc+sd-jwt', { vctValues: ['urn:eudi:pid:1'] }), {
    vct_values: ['urn:eudi:pid:1'],
  });
  assert.equal(mdocNamespaceForFormat('mso_mdoc', 'eu.europa.ec.eudi.pid.1'), 'eu.europa.ec.eudi.pid.1');
  assert.equal(mdocNamespaceForFormat('dc+sd-jwt', 'eu.europa.ec.eudi.pid.1'), undefined);
});

test('normalizeIdentifierType maps the retired VAT-No URI', () => {
  assert.equal(
    normalizeIdentifierType('http://data.europa.eu/eudi/id/VAT-No'),
    'http://data.europa.eu/eudi/id/VATIN'
  );
});

test('normalizeEntitlement expands short names and remaps ETSI URIs', () => {
  assert.equal(
    normalizeEntitlement('Service_Provider'),
    'http://data.europa.eu/eudi/entitlement/Service_Provider'
  );
  assert.equal(
    normalizeEntitlement('AGE_VERIFICATION'),
    'http://data.europa.eu/eudi/entitlement/Service_Provider'
  );
  assert.equal(
    normalizeEntitlement('https://uri.etsi.org/19475/Entitlement/PID_Provider'),
    'http://data.europa.eu/eudi/entitlement/PID_Provider'
  );
  assert.equal(
    normalizeEntitlement('http://data.europa.eu/eudi/entitlement/Service_Provider'),
    'http://data.europa.eu/eudi/entitlement/Service_Provider'
  );
});

test('shouldRegisterProvidedAttestations is true only for issuer roles', () => {
  assert.equal(
    shouldRegisterProvidedAttestations([
      'http://data.europa.eu/eudi/entitlement/Service_Provider',
    ]),
    false
  );
  assert.equal(
    shouldRegisterProvidedAttestations([
      'http://data.europa.eu/eudi/entitlement/PID_Provider',
    ]),
    true
  );
});

test('isoDateOnly emits YYYY-MM-DD', () => {
  assert.equal(isoDateOnly(new Date('2026-09-30T08:06:39.000Z')), '2026-09-30');
});

test('decodeFlexibleBase64 accepts standard and URL-safe payloads', () => {
  const original = Buffer.from('wrprc-bytes');
  assert.deepEqual(decodeFlexibleBase64(original.toString('base64')), original);
  assert.deepEqual(
    decodeFlexibleBase64(original.toString('base64url')),
    original
  );
});
