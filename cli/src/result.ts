import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function ownedDirectory(path: string) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  assert(
    stat.isDirectory() && stat.uid === process.getuid?.(),
    'Result directory must be owned by the caller and must not be a symlink',
  );
  return { directory, stat };
}

/** Clear an old result before validation, including when its directory is no longer private. */
export function invalidateResult(path: string): void {
  ownedDirectory(path);
  // lstat also finds broken symlinks. Unlink the entry, never its target.
  const previous = lstatSync(path, { throwIfNoEntry: false });
  if (previous) {
    assert(
      previous.uid === process.getuid?.() && (previous.isFile() || previous.isSymbolicLink()),
      'Cannot safely invalidate the previous result',
    );
    unlinkSync(path);
  }
}

/** Replace a result atomically; require a private directory on every write. */
export function writePrivateResult(path: string, value: Record<string, unknown>): void {
  const { directory, stat } = ownedDirectory(path);
  assert(!(stat.mode & 0o077), 'Result directory must be private');
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Classify failures without rendering untrusted messages, assertion values or API bodies. */
export function safeErrorCategory(error: unknown): string {
  const e = error as { status?: number; code?: string; name?: string; cause?: { code?: string } } | null;
  const status = e?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP ${status}`;
  const code = e?.code ?? e?.cause?.code;
  if (code === 'ENOENT') return 'input missing';
  if (code === 'EACCES' || code === 'EPERM') return 'filesystem permission denied';
  if (code === 'ERR_ASSERTION' || e?.name === 'SyntaxError' || code === 'ERR_INVALID_URL') return 'validation failed';
  if (
    e?.name === 'TimeoutError' ||
    ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code ?? '')
  )
    return 'transport failure';
  return 'operation failed';
}
