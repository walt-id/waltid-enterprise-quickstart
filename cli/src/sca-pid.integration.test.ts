import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { readScaPidConfig, scaPidContext, holderKeyReference } from './sca-pid-config.js';
import { RESOURCES } from './config.js';
import { setupScaPid, trustPolicy } from './commands/setup/sca-pid.js';
import { flowScaPid } from './flows/sca-pid.js';
import { extractCertificatePem, certificatePemToDerBase64, createGeneratedCertificate, certificateValidityWindow, proveSigningKey,
  listKeyReferences } from './commands/setup/keys.js';
import { X509Certificate } from 'node:crypto';
import { validateCertificateChain } from './commands/setup/certificates.js';
import { buildCertificateAnchorLote } from './trust-registry/lote.js';
import { loadTrustSource, listTrustRegistrySources, resolveTrustCertificateChain } from './trust-registry/client.js';

/** Run explicitly against a disposable local API; never consumes customer registrations. */
test('synthetic provisioning, scoped journeys, trust rejection and authenticated callbacks', async () => {
  const config = readScaPidConfig(process.env.SCA_PID_TEST_CONFIG!);
  assert(config.transport === 'local' && Object.values(config.trust).every(t => t.kind === 'fixture'));
  config.tenant = `test-${randomUUID()}`;
  const ctx = scaPidContext(config, process.env.SCA_PID_TEST_ADMIN_TOKEN!, process.cwd());
  // Exercise actual dispatch and successful results, then verify idempotent setup.
  const directory = await mkdtemp(join(tmpdir(), 'sca-pid-integration-'));
  try {
    const inputPath = join(directory, 'input.json'), resultPath = join(directory, 'result.json');
    await writeFile(inputPath, JSON.stringify(config), { mode: 0o600 });
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', new URL('../walt.ts', import.meta.url).pathname, '--setup-sca-pid', inputPath], {
        timeout: 120_000,
        env: { ...process.env, SCA_PID_API_TOKEN: process.env.SCA_PID_TEST_ADMIN_TOKEN, SCA_PID_RESULT_FILE: resultPath },
      });
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.outcome, 'successful');
    assert.equal(result.operation, 'setup');
    assert(stdout.includes(result.runId));
    assert(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await setupScaPid(ctx, config);
  const { orgClient: admin, tenantPath: target } = ctx;
  const certificate = async (id: string) => extractCertificatePem((await admin.get(`/v1/${target}.x509-store.${id}/x509-store-api/certificates`)).data)!;
  const root = await certificate('iaca'), leaf = await certificate('sca');
  await admin.post(`/v1/${target}.kms.unregistered/kms-service-api/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
  const unregisteredPem = await createGeneratedCertificate(ctx, 'unregistered', { storeRef: `${target}.x509-store`,
    subjectKeyRef: `${target}.kms.unregistered`, issuerKeyRef: `${target}.kms.iaca`, issuerCertificateRef: `${target}.x509-store.iaca`,
    subjectDn: 'C=AT,CN=Example unregistered signer', basicConstraintsCa: false, keyUsage: ['digitalSignature'],
    extendedKeyUsageOids: ['1.3.6.1.5.5.7.3.2'], ...certificateValidityWindow(180),
  }, 'unregistered', undefined, { createOnly: true });
  await validateCertificateChain([new X509Certificate(unregisteredPem), new X509Certificate(root)], [new X509Certificate(root)], { algorithms: ['ES256'] });
  await proveSigningKey(admin, `${target}.kms.unregistered`, new X509Certificate(unregisteredPem).publicKey);
  const unregistered = await resolveTrustCertificateChain(ctx, { certificateChainPemOrDer: [unregisteredPem, root],
    expectedEntityType: trustPolicy(config, 'sca').expectedEntityType, expectedServiceType: trustPolicy(config, 'sca').expectedServiceType });
  assert.equal(unregistered.decision, 'NOT_TRUSTED', 'A valid signer absent from registrations must be rejected without a processing failure');
  const lote = buildCertificateAnchorLote('unsigned', 'AT', [{ id: 'example', legalName: 'Example', country: 'AT', serviceName: 'Example',
    serviceType: 'http://uri.etsi.org/TrstSvc/Svctype/EAA', certificatePem: leaf }]);
  const unsigned = await loadTrustSource(ctx, { sourceId: 'unsigned-control', content: JSON.stringify(lote), acceptancePolicy: 'REQUIRE_AUTHENTICATED' });
  assert.equal(unsigned.success, false);
  assert(!unsigned.assurance?.accepted);
  const wrongSigner = (await admin.post(`/v1/${target}.kms.verifier/kms-service-api/keys/sign`, {
    format: 'jwt', plaintext: lote, headers: { x5c: [certificatePemToDerBase64(await certificate('verifier'))] },
  })).data.jwt;
  const rejected = await loadTrustSource(ctx, { sourceId: 'untrusted-source-control', content: wrongSigner, acceptancePolicy: 'REQUIRE_AUTHENTICATED', trustedSignerCertificates: [leaf] });
  assert.equal(rejected.success, false);
  assert(!(await listTrustRegistrySources(ctx)).some(s => ['unsigned-control', 'untrusted-source-control'].includes(s.sourceId)));

  const reference = `${target}.test-access`, role = `/v1/${target}.journey-operator/roles-api/roles`;
  const key = (await admin.post(`/v1/${reference}/apikeys-api/api-keys/create`, { name: 'Disposable scenario test', expiration: '1h' })).data;
  const callbackToken = randomBytes(32).toString('base64url');
  const callbacks: Array<{ target: string; event: string; status?: string }> = [];
  const receiver = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/sessions') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${callbackToken}`) { res.writeHead(401).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; assert(body.length <= 2_000_000); }
      const event = JSON.parse(body);
      assert(typeof event.target === 'string' && typeof event.event === 'string');
      callbacks.push({ target: event.target, event: event.event, status: event.session?.status });
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
  });
  const previousToken = process.env.SCA_PID_CALLBACK_TOKEN;
  try {
    await admin.post(`${role}/apikey/assign`, { apikey: reference });
    const scoped = scaPidContext(config, key.token, process.cwd());
    await admin.post(`/v1/${target}.wallet-kms.permission-control/kms-service-api/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
    const holderKeys = await listKeyReferences(admin, `${target}.wallet-kms`);
    assert.equal(holderKeys.length, 5); // Four provisioned holders and the permission-control key.
    assert(holderKeys.includes(holderKeyReference(target, 'sca-card-dpc', 'sca')));
    for (const keyReference of [
      `${target}.kms.sca`,
      holderKeyReference(target, 'sca-card-dpc', 'sca'),
      `${target}.wallet-kms.fresh-denial`,
    ]) {
      for (const [action, body] of [
        ['generate', { backend: 'jwk', keyType: 'secp256r1' }],
        ['sign', { format: 'jwt', plaintext: { sentinel: 'must-not-sign' } }],
        ['import/jwk', { kty: 'EC' }],
        ['store', { kty: 'EC' }],
      ] as const) {
        const response = await scoped.orgClient.request('POST', `/v1/${keyReference}/kms-service-api/keys/${action}`, body, { allow: [403] });
        assert.equal(response.status, 403);
      }
    }
    const sibling = `${config.tenant}-boundary`;
    await ctx.ensureResource(config.organization, sibling, { name: 'Synthetic authorization boundary' }, 'tenants');
    await ctx.ensureResource(`${config.organization}.${sibling}`, 'wallet', { type: 'wallet2' });
    for (const [method, path, body] of [
      ['GET', `/v1/${target}.kms.sca/kms-service-api/keys/view`, undefined],
      ['GET', `/v1/${target}.wallet-kms.permission-control/kms-service-api/keys/view`, undefined],
      ['POST', `/v1/${target}.journey-operator/roles-api/permissions/permissions/add-to-role`, { target, action: 'issuer-credential-issue', operation: 'ADD' }],
      ['GET', `/v2/${config.organization}.${sibling}.wallet/wallet-service-api/credentials`, undefined],
    ] as const) assert.equal((await scoped.orgClient.request(method, path, body, { allow: [403] })).status, 403);
    await setupScaPid(ctx, config); // Confirms the denied escalation did not alter the role.
    receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
    config.callbackUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/sessions`;
    assert.equal((await fetch(config.callbackUrl, { method: 'POST', body: '{}' })).status, 401);
    process.env.SCA_PID_CALLBACK_TOKEN = callbackToken;
    const result = await flowScaPid(scoped, config);
    assert.equal(result.outcome, 'successful');
    assert.deepEqual((await listKeyReferences(admin, `${target}.wallet-kms`)).sort(), holderKeys.sort(), 'Flow must reuse provisioned holder keys');
    for (let i = 0; i < 50 && callbacks.filter(c => c.event.startsWith('credential_request_') && c.event.endsWith('_succeeded')).length < 4; i++) await delay(100);
    const issuance = callbacks.filter(c => c.event.startsWith('credential_request_') && c.event.endsWith('_succeeded'));
    assert.equal(new Set(issuance.map(c => c.target)).size, 4);
    for (const event of issuance) {
      const sessions = (await scoped.orgClient.get(`/v2/${target}.${RESOURCES.issuer}/issuer-service-api/sessions?sessionId=${encodeURIComponent(event.target)}`)).data;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].issuanceSession.id, event.target);
    }
    const issuanceIds = new Set(issuance.map(c => c.target));
    const verification = callbacks.filter(c => c.status === 'SUCCESSFUL' && !issuanceIds.has(c.target));
    assert(verification.length >= 2);
    for (const event of verification) assert.equal((await scoped.orgClient.get(`/v2/${target}.${RESOURCES.verifier2}.${event.target}/verifier-service-api/verification-session/info`)).data.session.status, 'SUCCESSFUL');
  } finally {
    if (previousToken === undefined) delete process.env.SCA_PID_CALLBACK_TOKEN; else process.env.SCA_PID_CALLBACK_TOKEN = previousToken;
    if (receiver.listening) { receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve())); }
    await admin.delete(`/v1/${reference}/apikeys-api/api-keys/delete`);
  }
});
