import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { certificateFixture } from './certificate-fixture.js';
import { importCertificate, readSigningMaterial, validateCertificateChain, parseCertificates } from './certificates.js';
import { HttpClient } from '../../http/client.js';
import { createGeneratedCertificate } from './keys.js';
import { scaPidContext, readScaPidConfig } from '../../sca-pid-config.js';

const wrpac = {
  algorithms: ['RS256'] as const,
  rsaBits: 2048,
  dnsName: 'verifier.example.invalid',
  extendedKeyUsageOids: ['1.3.6.1.5.5.7.3.2'],
};
const pid = { algorithms: ['ES256'] as const, extendedKeyUsageOids: ['1.0.18013.5.1.2'] };
const provider = { algorithms: ['ES256'] as const, extendedKeyUsageOids: ['1.3.6.1.5.5.7.3.2'] };

test('registered material requires approved key, purpose, DNS SAN, private input and independent chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registered-certificate-'));
  const other = await mkdtemp(join(tmpdir(), 'foreign-certificate-'));
  try {
    const f = await certificateFixture(dir),
      foreign = await certificateFixture(other, 'pid');
    await writeFile(join(dir, 'chain.pem'), f.options.chainPem);
    await writeFile(join(dir, 'key.json'), JSON.stringify(f.pair.privateKey.export({ format: 'jwk' })), {
      mode: 0o600,
    });
    const config = {
      kind: 'registered' as const,
      chainFile: join(dir, 'chain.pem'),
      anchorsFile: join(dir, 'root.pem'),
      keyFile: join(dir, 'key.json'),
      publicKeySha256: f.options.expectedPublicKeySha256,
      sourceFile: 'unused',
      sourceSignerFile: 'unused',
      sourceUrl: 'https://example.invalid/list',
      entityType: 'ACCESS_CERTIFICATE_PROVIDER',
      serviceType: 'example',
    };
    await readSigningMaterial(config, wrpac);
    await assert.rejects(readSigningMaterial(config, { ...wrpac, dnsName: 'other.example.invalid' }));
    await assert.rejects(readSigningMaterial(config, { ...wrpac, rsaBits: 3072 }));
    for (const change of [{ publicKeySha256: '0'.repeat(64) }, { anchorsFile: join(other, 'root.pem') }])
      await assert.rejects(readSigningMaterial({ ...config, ...change }, wrpac));
    await assert.rejects(readSigningMaterial(config, pid));
    await validateCertificateChain(
      parseCertificates(foreign.options.chainPem),
      parseCertificates(foreign.options.anchorsPem),
      pid,
    );
    await assert.rejects(
      validateCertificateChain(
        parseCertificates(foreign.options.chainPem),
        parseCertificates(foreign.options.anchorsPem),
        provider,
      ),
    );
    assert.throws(() => parseCertificates(f.options.chainPem + f.leafPem));
    await assert.rejects(
      validateCertificateChain(
        parseCertificates(f.options.anchorsPem + f.leafPem),
        parseCertificates(f.options.anchorsPem),
        wrpac,
      ),
    );
    await chmod(config.keyFile, 0o644);
    await assert.rejects(readSigningMaterial(config, wrpac), /private regular file/);
    await chmod(config.keyFile, 0o600);
    await writeFile(config.keyFile, JSON.stringify(foreign.pair.privateKey.export({ format: 'jwk' })));
    await assert.rejects(readSigningMaterial(config, wrpac), /differ/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('import proves KMS possession before writing and refuses replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'import-certificate-'));
  try {
    const f = await certificateFixture(dir),
      events: string[] = [];
    let stored: { certificatePem: string } | undefined,
      wrongKey = false;
    const client = new HttpClient('https://example.invalid', { logging: 'none' });
    Object.assign(client, {
      async post(path: string, body: any) {
        events.push(path.endsWith('/sign') ? 'sign' : 'write');
        if (path.endsWith('/sign')) {
          const input =
            Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url') +
            '.' +
            Buffer.from(JSON.stringify(body.plaintext)).toString('base64url');
          return {
            data: {
              jwt:
                input +
                '.' +
                (wrongKey ? Buffer.from('wrong') : sign('sha256', Buffer.from(input), f.pair.privateKey)).toString(
                  'base64url',
                ),
            },
          };
        }
        assert.equal(stored, undefined);
        stored = { certificatePem: body.certificatePem };
        return { data: stored };
      },
      async get() {
        return stored ? { status: 200, data: stored } : { status: 404 };
      },
    });
    const importOne = () =>
      importCertificate(
        client,
        'example.tenant.x509-store.signer',
        'example.tenant.kms.signer',
        new X509Certificate(f.leafPem),
      );
    await importOne();
    assert.deepEqual(events, ['sign', 'write']);
    await importOne();
    wrongKey = true;
    await assert.rejects(importOne());
    wrongKey = false;
    stored = { certificatePem: f.options.anchorsPem };
    await assert.rejects(importOne(), /replacement/);
    assert.equal(events.filter((e) => e === 'write').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('create-only generation never upserts over a concurrent creator', async () => {
  const ctx = scaPidContext(
    readScaPidConfig(new URL('../../../sca-pid.example.json', import.meta.url).pathname),
    'fixture-token',
    process.cwd(),
  );
  let upserts = 0;
  Object.assign(ctx.orgClient, {
    post: async () => {
      throw new Error('Concurrent creator: HTTP 409');
    },
    put: async () => {
      upserts++;
    },
  });
  await assert.rejects(
    createGeneratedCertificate(
      ctx,
      'signer',
      {
        subjectKeyRef: 'example.sca-pid.kms.signer',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2027-01-01T00:00:00Z',
      },
      'signer',
      undefined,
      { createOnly: true },
    ),
    /Concurrent creator/,
  );
  assert.equal(upserts, 0);
});

test('certificate generation keeps default upsert behavior and reads the caller-selected store', async () => {
  const ctx = scaPidContext(
    readScaPidConfig(new URL('../../../sca-pid.example.json', import.meta.url).pathname),
    'fixture-token',
    process.cwd(),
  );
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
  assert.equal(
    await createGeneratedCertificate(
      ctx,
      'signer',
      {
        subjectKeyRef: 'example.sca-pid.kms.signer',
        storeRef: 'example.sca-pid.other-store',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2027-01-01T00:00:00Z',
      },
      'signer',
    ),
    'synthetic PEM response',
  );
  assert.deepEqual(calls, [
    'PUT /v1/example.sca-pid.x509-service.signer/x509-service-api/certificates',
    'GET /v1/example.sca-pid.other-store.signer/x509-store-api/certificates',
  ]);
});
