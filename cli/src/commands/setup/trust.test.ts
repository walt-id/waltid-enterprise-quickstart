import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandContext } from '../../context.js';
import { Config } from '../../config.js';
import {
  loadRelyingPartyIntoTrustRegistry,
  pinWallet2RequestObjectTrustAnchor,
} from './trust.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
const IACA_PEM = '-----BEGIN CERTIFICATE-----\nIACA\n-----END CERTIFICATE-----';

class FakeOrgClient {
  posts: unknown[] = [];
  puts: Array<{ path: string; body: unknown }> = [];
  sources: Array<{ sourceId: string; assurance?: { accepted?: boolean } }> = [];
  walletConfig: Record<string, unknown> = { configuration: {} };
  postResult: { data: Record<string, unknown> } = {
    data: {
      success: true,
      entitiesLoaded: 1,
      servicesLoaded: 1,
      identitiesLoaded: 1,
      assurance: { accepted: true },
    },
  };
  postError: { status?: number; message?: string } | null = null;

  async get(path: string) {
    if (path.endsWith('/sources')) return { data: this.sources };
    if (path.endsWith('/configuration/view')) return { data: this.walletConfig };
    if (path.includes('verifier-request-signing')) return { data: { certificatePem: PEM } };
    return { data: { certificatePem: IACA_PEM } };
  }

  async post(_path: string, body: unknown) {
    this.posts.push(body);
    if (this.postError) throw this.postError;
    return this.postResult;
  }

  async put(path: string, body: unknown) {
    this.puts.push({ path, body });
    return { data: {} };
  }
}

function context(): { ctx: CommandContext; client: FakeOrgClient } {
  const config: Config = {
    baseUrl: 'enterprise.localhost',
    organization: 'waltid',
    tenant: 'waltid-tenant01',
    email: 'admin@example.test',
    password: 'secret',
    port: 7500,
    superadminToken: '',
    adminEmail: 'admin@example.test',
    adminPassword: 'secret',
  };
  const ctx = new CommandContext(config, mkdtempSync(join(tmpdir(), 'rp-trust-')));
  const client = new FakeOrgClient();
  Object.assign(ctx, { orgClient: client });
  return { ctx, client };
}

test('fresh RP import posts the verifier request-signing leaf once', async () => {
  const { ctx, client } = context();
  await loadRelyingPartyIntoTrustRegistry(ctx);
  assert.equal(client.posts.length, 1);
});

test('an already accepted RP source is reused without another import', async () => {
  const { ctx, client } = context();
  client.sources = [{ sourceId: 'journey-rp-local', assurance: { accepted: true } }];
  await loadRelyingPartyIntoTrustRegistry(ctx);
  assert.equal(client.posts.length, 0);
});

test('a duplicate-looking failure is propagated when the source stays unaccepted', async () => {
  const { ctx, client } = context();
  client.postError = { status: 409, message: 'Duplicate target' };
  client.sources = [{ sourceId: 'journey-rp-local', assurance: { accepted: false } }];
  await assert.rejects(
    () => loadRelyingPartyIntoTrustRegistry(ctx),
    /not accepted/,
  );
  assert.equal(client.posts.length, 1);
});

test('Wallet2 Request Object trust pins the IACA CA', async () => {
  const { ctx, client } = context();
  await pinWallet2RequestObjectTrustAnchor(ctx);
  assert.equal(client.puts.length, 1);
  const body = client.puts[0].body as {
    configuration: { requestObjectX509Trust: { x509TrustAnchorsPem: string[] } };
  };
  assert.equal(body.configuration.requestObjectX509Trust.x509TrustAnchorsPem[0], IACA_PEM);
  assert.match(client.puts[0].path, /wallet-service-api\/configuration\/update$/);
});

test('an already pinned IACA is not written again', async () => {
  const { ctx, client } = context();
  client.walletConfig = {
    configuration: {
      requestObjectX509Trust: { x509TrustAnchorsPem: [IACA_PEM] },
    },
  };
  await pinWallet2RequestObjectTrustAnchor(ctx);
  assert.equal(client.puts.length, 0);
});
