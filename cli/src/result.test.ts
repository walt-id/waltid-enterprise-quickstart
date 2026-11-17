import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeErrorCategory } from './result.js';

const exec = promisify(execFile);
const cli = new URL('../walt.ts', import.meta.url).pathname;
async function failingCommand(input: string, result: string) {
  try {
    await exec(process.execPath, ['--import', 'tsx', cli, '--setup-sca-pid', input], {
      timeout: 10_000,
      env: { ...process.env, SCA_PID_API_TOKEN: 'token-sentinel', SCA_PID_RESULT_FILE: result },
    });
    assert.fail('Command must exit unsuccessfully');
  } catch (error: any) {
    assert.equal(error.code, 1);
    const output = error.stdout + error.stderr;
    for (const secret of [input, result, 'token-sentinel', 'private-input-sentinel']) assert(!output.includes(secret));
    return output as string;
  }
}

test('actual CLI replaces prior success on invalid input with a distinct failed run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-result-'));
  try {
    const input = join(dir, 'input.json'),
      result = join(dir, 'result.json');
    writeFileSync(input, '{"secret":"private-input-sentinel"}');
    writeFileSync(result, '{"outcome":"successful","runId":"old"}');
    const output = await failingCommand(input, result);
    const receipt = JSON.parse(readFileSync(result, 'utf8'));
    assert.equal(receipt.outcome, 'failed');
    assert.equal(receipt.operation, 'setup');
    assert.equal(receipt.stage, 'configuration');
    assert.notEqual(receipt.runId, 'old');
    assert(output.includes(receipt.runId) && output.includes('configuration'));
    assert(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
    assert.equal(statSync(result).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actual CLI removes stale success when result directory permissions become unsafe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-result-'));
  try {
    const result = join(dir, 'result.json');
    writeFileSync(result, '{"outcome":"successful"}');
    chmodSync(dir, 0o755);
    const output = await failingCommand(join(dir, 'missing.json'), result);
    assert(!existsSync(result));
    assert(output.includes('result initialization') && output.includes('no result was written'));
    assert.equal(statSync(dir).mode & 0o777, 0o755, 'Must not silently change operator permissions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('actual CLI reports inability to invalidate unsafe destinations without following symlinks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-result-'));
  try {
    const destination = join(dir, 'real');
    mkdirSync(destination, { mode: 0o700 });
    const result = join(destination, 'result.json');
    const previous = '{"outcome":"successful"}';
    writeFileSync(result, previous);
    const link = join(dir, 'link');
    symlinkSync(destination, link);
    const output = await failingCommand(join(dir, 'missing.json'), join(link, 'result.json'));
    assert(output.includes('discard any previous result'));
    assert.equal(readFileSync(result, 'utf8'), previous);
    chmodSync(destination, 0o500);
    const denied = await failingCommand(join(dir, 'missing.json'), result);
    assert(denied.includes('discard any previous result'));
    assert.equal(readFileSync(result, 'utf8'), previous);
    chmodSync(destination, 0o700);
    const fileLink = join(dir, 'result-link.json');
    symlinkSync(result, fileLink);
    await failingCommand(join(dir, 'missing.json'), fileLink);
    assert.equal(readFileSync(result, 'utf8'), previous);
    assert.equal(JSON.parse(readFileSync(fileLink, 'utf8')).category, 'input missing');
  } finally {
    chmodSync(join(dir, 'real'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diagnostics classify known failures without exposing messages or arbitrary error codes', () => {
  assert.equal(safeErrorCategory({ status: 403, message: 'secret' }), 'HTTP 403');
  assert.equal(safeErrorCategory({ cause: { code: 'ECONNREFUSED' } }), 'transport failure');
  assert.equal(safeErrorCategory({ code: 'ERR_ASSERTION', actual: 'secret' }), 'validation failed');
  assert.equal(safeErrorCategory({ code: 'secret', message: 'secret' }), 'operation failed');
});
