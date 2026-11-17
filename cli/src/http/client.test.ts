import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpClient } from './client.js';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';

test('sensitive HTTP transport retains no bodies or identifiers on success or failure', async () => {
  const original = globalThis.fetch;
  const client = new HttpClient('https://api.example.org', { logging: 'none', strictTransport: true, timeoutMs: 5000 });
  client.setToken('token-sentinel');
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer token-sentinel');
      assert.equal(init?.redirect, 'error');
      assert(init?.signal);
      return Response.json({ credential: 'response-sentinel' });
    };
    assert.equal((await client.post('/offer?secret=query-sentinel', { privateKey: 'request-sentinel' })).data.credential, 'response-sentinel');
    assert.deepEqual(client.getHttpLog(), []);
    globalThis.fetch = async () => Response.json({ secret: 'failure-sentinel' }, { status: 403 });
    await assert.rejects(client.get('/private'),
      (error: any) => error.message === 'HTTP 403' && error.status === 403 && error.response === undefined);
    assert.deepEqual(client.getHttpLog(), []);
  } finally { globalThis.fetch = original; }
});

test('strict transport rejects cross-origin paths before fetch and supports anonymous management controls', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const client = new HttpClient('https://api.example.org', { logging: 'none', strictTransport: true });
  client.setToken('not-for-anonymous-call');
  try {
    globalThis.fetch = async (_url, init) => { calls++; assert(!('Authorization' in (init!.headers as object))); return new Response('', { status: 403 }); };
    for (const path of ['//other.example.org', '/\\other.example.org', 'https://other.example.org']) await assert.rejects(client.get(path));
    assert.equal(calls, 0);
    assert.equal((await client.request('POST', '/management', {}, { auth: false, allow: [403] })).status, 403);
  } finally { globalThis.fetch = original; }
});

test('real HTTPS verifies certificates and refuses to send credentials to redirect targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-https-'));
  const exec = promisify(execFile);
  let leaked = 0;
  const sink = httpServer((_req, res) => { leaked++; res.end('unexpected'); });
  let server: ReturnType<typeof httpsServer> | undefined;
  try {
    const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
    sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
    server = httpsServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
      if (req.url === '/redirect') res.writeHead(302, { Location: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/` }).end();
      else { assert.equal(req.headers.authorization, 'Bearer synthetic-token'); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `https://localhost:${(server.address() as AddressInfo).port}`;
    await assert.rejects(new HttpClient(base, { strictTransport: true, logging: 'none' }).get('/ok'));
    const script = `import assert from 'node:assert/strict'; import { HttpClient } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
      const client = new HttpClient(${JSON.stringify(base)}, { strictTransport: true, logging: 'none', timeoutMs: 5000 });
      client.setToken('synthetic-token'); assert.deepEqual((await client.get('/ok')).data, {ok:true});
      await assert.rejects(client.get('/redirect')); assert.deepEqual(client.getHttpLog(), []);`;
    await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: cert } });
    assert.equal(leaked, 0);
  } finally {
    for (const s of [server, sink]) if (s?.listening) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('ordinary HTTP callers retain diagnostics, raw bodies and redacted logs; empty JSON responses are accepted', async () => {
  const original = globalThis.fetch;
  const client = new HttpClient('https://api.example.org');
  client.setToken('private-token');
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.body, 'resource.path');
      assert.equal((options?.headers as Record<string, string>)['Content-Type'], 'text/plain');
      return new Response(null, { status: 204, headers: { 'content-type': 'application/json' } });
    };
    assert.equal((await client.postRaw('/dependencies', 'resource.path', 'text/plain')).status, 204);
    assert.equal(client.getHttpLog()[0].request.headers.Authorization, '[REDACTED]');
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.body, 'false');
      return Response.json({ reason: 'ordinary diagnostic' }, { status: 409, statusText: 'Conflict' });
    };
    await assert.rejects(
      client.post('/resource', false),
      (error: any) => error.message === 'HTTP 409: Conflict' && error.response.data.reason === 'ordinary diagnostic',
    );
    assert.equal(client.getHttpLog().length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
