import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialStatusRegistry } from './status.js';

const S3_ENV = [
  'CREDENTIAL_STATUS_S3_BUCKET',
  'CREDENTIAL_STATUS_S3_REGION',
  'CREDENTIAL_STATUS_S3_ACCESS_KEY_ID',
  'CREDENTIAL_STATUS_S3_SECRET_KEY',
] as const;

function withEnv(values: Partial<Record<(typeof S3_ENV)[number], string>>, fn: () => void): void {
  const previous = Object.fromEntries(S3_ENV.map((name) => [name, process.env[name]]));
  for (const name of S3_ENV) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  try {
    fn();
  } finally {
    for (const name of S3_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('credentialStatusRegistry stays in-memory without a bucket', () => {
  withEnv({}, () => {
    assert.deepEqual(credentialStatusRegistry(), { type: 'in-memory' });
  });
});

test('credentialStatusRegistry uses S3 with static keys when a bucket is set', () => {
  withEnv(
    {
      CREDENTIAL_STATUS_S3_BUCKET: 'status-bucket',
      CREDENTIAL_STATUS_S3_REGION: 'eu-west-2',
      CREDENTIAL_STATUS_S3_ACCESS_KEY_ID: 'AKIA',
      CREDENTIAL_STATUS_S3_SECRET_KEY: 'secret',
    },
    () => {
      assert.deepEqual(credentialStatusRegistry(), {
        type: 'aws',
        bucketName: 'status-bucket',
        region: 'eu-west-2',
        accessKeyId: 'AKIA',
        secretKey: 'secret',
      });
    }
  );
});

test('credentialStatusRegistry leaves keys out so the SDK credential chain applies', () => {
  withEnv({ CREDENTIAL_STATUS_S3_BUCKET: 'status-bucket', CREDENTIAL_STATUS_S3_REGION: 'eu-west-2' }, () => {
    assert.deepEqual(credentialStatusRegistry(), { type: 'aws', bucketName: 'status-bucket', region: 'eu-west-2' });
  });
});

test('credentialStatusRegistry requires a region with the bucket', () => {
  withEnv({ CREDENTIAL_STATUS_S3_BUCKET: 'status-bucket' }, () => {
    assert.throws(() => credentialStatusRegistry(), /CREDENTIAL_STATUS_S3_REGION is required/);
  });
});
