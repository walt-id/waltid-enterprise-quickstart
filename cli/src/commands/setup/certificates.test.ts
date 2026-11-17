import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importCertificate, readSigningMaterial, validateCertificateChain, parseCertificates } from './certificates.js';
import { HttpClient } from '../../http/client.js';
import { createGeneratedCertificate } from './keys.js';
import { scaPidContext, readScaPidConfig, signerCertificateRequirements } from '../../sca-pid-config.js';

test('registered material requires approved key, purpose, DNS SAN, private input and independent chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registered-certificate-'));
  const other = await mkdtemp(join(tmpdir(), 'foreign-certificate-'));
  try {
    const f = await certificateFixture(dir), foreign = await certificateFixture(other, 'pid');
    await writeFile(join(dir, 'chain.pem'), f.options.chainPem);
    await writeFile(join(dir, 'key.json'), JSON.stringify(f.pair.privateKey.export({ format: 'jwk' })), { mode: 0o600 });
    const config = { kind: 'registered' as const, chainFile: join(dir, 'chain.pem'), anchorsFile: join(dir, 'root.pem'), keyFile: join(dir, 'key.json'),
      publicKeySha256: f.options.expectedPublicKeySha256, certificateProfile: 'wrpac' as const, dnsName: 'verifier.example.invalid',
      sourceFile: 'source.json', sourceSignerFile: 'signer.pem', sourceUrl: 'https://trust.example.org/list',
      entityType: 'ACCESS_CERTIFICATE_PROVIDER', serviceType: 'urn:example:relying-party' };
    const wrpac = signerCertificateRequirements('verifier', config);
    assert.equal(wrpac.rsaBits, 2048);
    assert.deepEqual(wrpac.algorithms, ['RS256']);
    for (const role of ['sca', 'pid', 'provider'] as const) assert.deepEqual(signerCertificateRequirements(role).algorithms, ['ES256']);
    assert.deepEqual(signerCertificateRequirements('verifier').algorithms, ['ES256', 'RS256']);
    await readSigningMaterial(config, wrpac);
    await assert.rejects(readSigningMaterial(config, signerCertificateRequirements('verifier', { ...config, dnsName: 'other.example.invalid' })), /approved DNS SAN/);
    await assert.rejects(readSigningMaterial(config, { ...wrpac, rsaBits: 3072 }), /RSA modulus size/);
    for (const change of [{ publicKeySha256: '0'.repeat(64) }, { anchorsFile: join(other, 'root.pem') }])
      await assert.rejects(readSigningMaterial({ ...config, ...change }, wrpac));
    await assert.rejects(readSigningMaterial(config, signerCertificateRequirements('pid')), /required extended key usage/);
    for (const role of ['sca', 'pid'] as const)
      await validateCertificateChain(parseCertificates(foreign.options.chainPem), parseCertificates(foreign.options.anchorsPem), signerCertificateRequirements(role));
    for (const role of ['provider', 'verifier'] as const)
      await assert.rejects(validateCertificateChain(parseCertificates(foreign.options.chainPem), parseCertificates(foreign.options.anchorsPem), signerCertificateRequirements(role)), /required extended key usage/);
    for (const role of ['sca', 'provider'] as const)
      await assert.rejects(readSigningMaterial(config, signerCertificateRequirements(role)), /Unsupported signing key/);
    await validateCertificateChain(parseCertificates(f.options.chainPem), parseCertificates(f.options.anchorsPem), signerCertificateRequirements('verifier'));
    assert.throws(() => parseCertificates(f.options.chainPem + f.leafPem));
    await assert.rejects(validateCertificateChain(parseCertificates(f.options.anchorsPem + f.leafPem), parseCertificates(f.options.anchorsPem), wrpac));
    await chmod(config.keyFile, 0o644);
    await assert.rejects(readSigningMaterial(config, wrpac), /private regular file/);
    await chmod(config.keyFile, 0o600);
    await writeFile(config.keyFile, JSON.stringify(foreign.pair.privateKey.export({ format: 'jwk' })));
    await assert.rejects(readSigningMaterial(config, wrpac), /differ/);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

// OpenSSL independently issues the test chain; production validation never mints it.
async function certificateFixture(directory: string, profile: 'wrpac' | 'pid' = 'wrpac') {
  const exec = promisify(execFile);
  const root = join(directory, 'root.pem'), rootKey = join(directory, 'root.key');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', rootKey, '-out', root, '-days', '3', '-subj', '/CN=Synthetic Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const pair = profile === 'wrpac' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(join(directory, 'leaf.key'), pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await exec('openssl', ['req', '-new', '-key', join(directory, 'leaf.key'), '-out', join(directory, 'leaf.csr'), '-subj', '/CN=verifier.example.invalid']);
  await writeFile(join(directory, 'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:verifier.example.invalid\nextendedKeyUsage=' + (profile === 'pid' ? '1.0.18013.5.1.2' : 'clientAuth') + '\n');
  await exec('openssl', ['x509', '-req', '-in', join(directory, 'leaf.csr'), '-CA', root, '-CAkey', rootKey, '-set_serial', '2', '-days', '2', '-extfile', join(directory, 'extensions'), '-out', join(directory, 'leaf.pem')]);
  const anchorsPem = await readFile(root, 'utf8'), leafPem = await readFile(join(directory, 'leaf.pem'), 'utf8');
  return { pair, leafPem, options: { chainPem: leafPem + anchorsPem, anchorsPem,
    expectedPublicKeySha256: createHash('sha256').update(pair.publicKey.export({ format: 'der', type: 'spki' })).digest('hex') } };
}

test('import proves KMS possession before writing and refuses replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'import-certificate-'));
  try {
    const f = await certificateFixture(dir), events: string[] = [];
    let stored: { certificatePem: string } | undefined, wrongKey = false;
    const client = new HttpClient('https://example.invalid', { logging: 'none' });
    Object.assign(client, {
      async post(path: string, body: any) {
        events.push(path.endsWith('/sign') ? 'sign' : 'write');
        if (path.endsWith('/sign')) {
          assert.equal(path, '/v1/example.tenant.kms.signer/kms-service-api/keys/sign');
          const input = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(body.plaintext)).toString('base64url');
          return { data: { jwt: input + '.' + (wrongKey ? Buffer.from('wrong') : sign('sha256', Buffer.from(input), f.pair.privateKey)).toString('base64url') } };
        }
        assert.equal(path, '/v1/example.tenant.x509-store.signer/x509-store-api/certificates');
        assert.equal(stored, undefined); stored = { certificatePem: body.certificatePem }; return { data: stored };
      },
      async get(path: string) {
        assert.equal(path, '/v1/example.tenant.x509-store.signer/x509-store-api/certificates');
        return stored ? { status: 200, data: stored } : { status: 404 };
      },
    });
    const importOne = () => importCertificate(client, 'example.tenant.x509-store.signer', 'example.tenant.kms.signer', new X509Certificate(f.leafPem));
    await importOne();
    assert.deepEqual(events, ['sign', 'write']);
    await importOne();
    wrongKey = true; await assert.rejects(importOne()); wrongKey = false;
    stored = { certificatePem: f.options.anchorsPem };
    await assert.rejects(importOne(), /replacement/);
    assert.equal(events.filter(e => e === 'write').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('create-only generation never upserts over a concurrent creator', async () => {
  const ctx = scaPidContext(readScaPidConfig(new URL('../../../sca-pid.example.json', import.meta.url).pathname), 'fixture-token', process.cwd());
  let upserts = 0;
  Object.assign(ctx.orgClient, {
    post: async () => { throw new Error('Concurrent creator: HTTP 409'); },
    put: async () => { upserts++; },
  });
  await assert.rejects(createGeneratedCertificate(ctx, 'signer', { subjectKeyRef: 'example.sca-pid.kms.signer', validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' }, 'signer', undefined,
    { createOnly: true }), /Concurrent creator/);
  assert.equal(upserts, 0);
});

test('certificate generation keeps default upsert behavior and reads the caller-selected store', async () => {
  const ctx = scaPidContext(readScaPidConfig(new URL('../../../sca-pid.example.json', import.meta.url).pathname), 'fixture-token', process.cwd());
  const calls: string[] = [];
  Object.assign(ctx.orgClient, {
    async put(path: string, body: { storeRef: string }) {
      calls.push(`PUT ${path}`);
      assert.equal(body.storeRef, 'example.sca-pid.other-store');
      return { data: {} };
    },
    async get(path: string) {
      calls.push(`GET ${path}`);
      return { data: { certificatePem: 'synthetic PEM response' } };
    },
  });
  const pem = await createGeneratedCertificate(ctx, 'signer', {
    subjectKeyRef: 'example.sca-pid.kms.signer', storeRef: 'example.sca-pid.other-store',
    validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z',
  }, 'signer');
  assert.equal(pem, 'synthetic PEM response');
  assert.deepEqual(calls, [
    'PUT /v1/example.sca-pid.x509-service.signer/x509-service-api/certificates',
    'GET /v1/example.sca-pid.other-store.signer/x509-store-api/certificates',
  ]);
});
