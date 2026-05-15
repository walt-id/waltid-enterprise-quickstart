/**
 * Minimal .env file loader for CLI configuration.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Load KEY=VALUE pairs from an env file into process.env.
 * Lines starting with # are ignored. Values may be quoted.
 */
export function loadEnvFile(filePath: string, options?: { override?: boolean }): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  const override = options?.override ?? false;
  const content = readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (override || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }

  return true;
}

/** Load general CLI settings from cli/walt.env (see walt.env.example). */
export function loadWaltEnv(cliDir: string): boolean {
  return loadEnvFile(join(cliDir, 'walt.env'));
}
