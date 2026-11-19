import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createConfig, MDL_DOC_TYPE, PID_DOC_TYPE, selectedMdocDcqlCredential } from './config.js';

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

test('quickstart configuration uses bundled credentials and permits deployment overrides', () => {
  const names = ['EMAIL', 'PASSWORD', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const defaults = createConfig(root);
    assert.equal(defaults.email, 'superadmin@walt.id');
    assert.equal(defaults.password, 'violet orchard river lantern');
    assert.equal(defaults.adminPassword, 'violet meadow river lantern');

    process.env.PASSWORD = 'existing bootstrap passphrase';
    process.env.ADMIN_PASSWORD = 'existing admin passphrase';
    const overridden = createConfig(root);
    assert.equal(overridden.password, process.env.PASSWORD);
    assert.equal(overridden.adminPassword, process.env.ADMIN_PASSWORD);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
