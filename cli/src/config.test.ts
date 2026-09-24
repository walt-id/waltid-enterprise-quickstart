import assert from 'node:assert/strict';
import test from 'node:test';
import { MDL_DOC_TYPE, PID_DOC_TYPE, selectedMdocDcqlCredential } from './config.js';

test('selectedMdocDcqlCredential defaults to the PID doctype', () => {
  const previous = process.env.CREDENTIAL_TYPE;
  delete process.env.CREDENTIAL_TYPE;
  try {
    const query = selectedMdocDcqlCredential('my');
    assert.equal(query.id, 'my_pid');
    assert.equal(query.format, 'mso_mdoc');
    assert.equal(query.meta.doctype_value, PID_DOC_TYPE);
    assert.deepEqual(query.claims[0]?.path, [PID_DOC_TYPE, 'family_name']);
  } finally {
    if (previous === undefined) delete process.env.CREDENTIAL_TYPE;
    else process.env.CREDENTIAL_TYPE = previous;
  }
});

test('selectedMdocDcqlCredential follows CREDENTIAL_TYPE=mdl', () => {
  const previous = process.env.CREDENTIAL_TYPE;
  process.env.CREDENTIAL_TYPE = 'mdl';
  try {
    const query = selectedMdocDcqlCredential('trust_list');
    assert.equal(query.id, 'trust_list_mdl');
    assert.equal(query.meta.doctype_value, MDL_DOC_TYPE);
    assert.deepEqual(query.claims[0]?.path, ['org.iso.18013.5.1', 'family_name']);
  } finally {
    if (previous === undefined) delete process.env.CREDENTIAL_TYPE;
    else process.env.CREDENTIAL_TYPE = previous;
  }
});
