import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRevocationJourneyStatusList,
  credentialStatusRegistry,
  REVOCATION_JOURNEY_STATUS_CONFIG_ID,
  revocationJourneyCreatePath,
  revocationJourneyStatusRequest,
  STATUS_LIST_TEST_TTL_SECONDS,
} from './status.js';

test('credentialStatusRegistry uses the database when no S3 bucket is set', () => {
  const bucket = process.env.CREDENTIAL_STATUS_S3_BUCKET;
  const region = process.env.CREDENTIAL_STATUS_S3_REGION;
  delete process.env.CREDENTIAL_STATUS_S3_BUCKET;
  delete process.env.CREDENTIAL_STATUS_S3_REGION;
  try {
    assert.deepEqual(credentialStatusRegistry(), { type: 'database' });
  } finally {
    restore('CREDENTIAL_STATUS_S3_BUCKET', bucket);
    restore('CREDENTIAL_STATUS_S3_REGION', region);
  }
});

test('credentialStatusRegistry publishes to S3 when the bucket and region are set', () => {
  const bucket = process.env.CREDENTIAL_STATUS_S3_BUCKET;
  const region = process.env.CREDENTIAL_STATUS_S3_REGION;
  const accessKey = process.env.CREDENTIAL_STATUS_S3_ACCESS_KEY_ID;
  const secret = process.env.CREDENTIAL_STATUS_S3_SECRET_KEY;
  process.env.CREDENTIAL_STATUS_S3_BUCKET = 'status-lists';
  process.env.CREDENTIAL_STATUS_S3_REGION = 'eu-central-1';
  delete process.env.CREDENTIAL_STATUS_S3_ACCESS_KEY_ID;
  delete process.env.CREDENTIAL_STATUS_S3_SECRET_KEY;
  try {
    assert.deepEqual(credentialStatusRegistry(), {
      type: 'aws',
      bucketName: 'status-lists',
      region: 'eu-central-1',
    });
  } finally {
    restore('CREDENTIAL_STATUS_S3_BUCKET', bucket);
    restore('CREDENTIAL_STATUS_S3_REGION', region);
    restore('CREDENTIAL_STATUS_S3_ACCESS_KEY_ID', accessKey);
    restore('CREDENTIAL_STATUS_S3_SECRET_KEY', secret);
  }
});

test('the revocation journey creates its own short-TTL list and leaves an existing one in place', async () => {
  const request = revocationJourneyStatusRequest({
    tenantPath: 'waltid.waltid-tenant01',
    ctx: { docSignerPem: 'cert' },
  } as never);
  assert.equal((request.config as { ttl: number }).ttl, STATUS_LIST_TEST_TTL_SECONDS);
  assert.equal(request.config && (request.config as { type: string }).type, 'TokenStatusList');
  const target = `waltid.waltid-tenant01.credential-status.${REVOCATION_JOURNEY_STATUS_CONFIG_ID}`;
  assert.equal(revocationJourneyCreatePath(target).includes(REVOCATION_JOURNEY_STATUS_CONFIG_ID), true);
  assert.equal(revocationJourneyCreatePath(target).includes('token-status-list-cwt/'), false);

  const calls: string[] = [];
  const conflict = await createRevocationJourneyStatusList(async (path) => {
    calls.push(path);
    throw Object.assign(new Error('already exists'), { status: 409 });
  }, target, request);
  assert.equal(conflict, 'exists');
  assert.deepEqual(calls, [revocationJourneyCreatePath(target)]);

  await assert.rejects(
    createRevocationJourneyStatusList(async () => {
      throw Object.assign(new Error('unavailable'), { status: 503 });
    }, target, request),
    /unavailable/,
  );
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
