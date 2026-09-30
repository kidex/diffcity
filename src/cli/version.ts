import { readFileSync } from 'node:fs';

// package.json sits one level above both src/ and dist/, so the same relative URL works in both.
const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

export function readVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
  const version = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`diffcity: no string "version" field in ${PACKAGE_JSON_URL.pathname}`);
  }
  return version;
}
