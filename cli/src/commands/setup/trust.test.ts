import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommandContext } from '../../context.js';
import { Config } from '../../config.js';
import { loadRelyingPartyIntoTrustRegistry } from './trust.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

class FakeOrgClient {
  posts: unknown[] = [];
  sources: Array<{ sourceId: string; assurance?: { accepted?: boolean } }> = [];
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
    return { data: { certificatePem: PEM } };
  }

  async post(_path: string, body: unknown) {
    this.posts.push(body);
    if (this.postError) throw this.postError;
    return this.postResult;
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
