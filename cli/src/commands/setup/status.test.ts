import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialStatusRegistry } from './status.js';

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

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
