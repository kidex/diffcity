// Socket protocol v1 (ADR-016): one request per connection, a JSON line of at
// most 64 KiB; the response is one JSON line. This module validates a request
// line into the typed SocketRequest from src/core/model/types.ts.
//
// `import` (ADR-036) has its own cap, 4 MiB, and its own timeout, 30 s (the
// daemon waits up to 20 s for a snapshot). The server reads past 64 KiB only
// for a line that starts as an import request: `{"v":1,"type":"import",` (the
// order JSON.stringify gives the CLI's request; whitespace allowed), and
// refuses a parsed request of another type over 64 KiB.

import { isAbsolute } from 'node:path';
import { checkImportPayload } from '../../core/findings/import.js';
import type { SocketRequest, SocketRequestType } from '../../core/model/types.js';

/** Longest request line, in bytes, without the newline. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Longest `import` request line, in bytes, without the newline (ADR-036). */
export const MAX_IMPORT_REQUEST_BYTES = 4 * 1024 * 1024;

/** A connection is closed if the exchange is not over within this time. */
export const REQUEST_TIMEOUT_MS = 5000;

/** The timeout of an `import` exchange, from the connection: above the daemon's 20 s wait for a snapshot. */
export const IMPORT_REQUEST_TIMEOUT_MS = 30_000;

export const PROTOCOL_VERSION = 1;

const REQUEST_TYPES: ReadonlySet<string> = new Set<SocketRequestType>(['ping', 'track', 'register', 'import', 'shutdown']);

/** The start of a line that may grow to MAX_IMPORT_REQUEST_BYTES. */
const IMPORT_START = /^\s*\{\s*"v"\s*:\s*1\s*,\s*"type"\s*:\s*"import"\s*,/;

/** Enough of a line to recognise IMPORT_START, whitespace included. */
export const IMPORT_START_PEEK_BYTES = 256;

/** True when `head`, the first bytes of a request line, starts as an `import` request. */
export function startsAsImport(head: string): boolean {
  return IMPORT_START.test(head);
}

/** The longest line a request of `type` may have. */
export function maxBytesFor(type: SocketRequestType): number {
  return type === 'import' ? MAX_IMPORT_REQUEST_BYTES : MAX_REQUEST_BYTES;
}

export type ParseResult = { ok: true; request: SocketRequest } | { ok: false; error: string };

const fail = (error: string): ParseResult => ({ ok: false, error });

/** A field value for an error message; JSON.stringify(undefined) is undefined at run time. */
const show = (value: unknown): string => (value === undefined ? 'missing' : JSON.stringify(value));

const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value);

/** Parses and validates one request line. Unknown extra fields are ignored. */
export function parseRequest(line: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return fail('invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('request must be a JSON object');
  const fields = value as Record<string, unknown>;

  if (fields.v !== PROTOCOL_VERSION) return fail(`unsupported protocol version: ${show(fields.v)}`);
  const type = fields.type;
  if (typeof type !== 'string' || !REQUEST_TYPES.has(type)) {
    return fail(`unknown request type: ${typeof type === 'string' ? type : show(type)}`);
  }

  switch (type as SocketRequestType) {
    case 'ping':
      return { ok: true, request: { v: 1, type: 'ping' } };
    case 'shutdown':
      return { ok: true, request: { v: 1, type: 'shutdown' } };
    case 'track': {
      const { dir, agent, at } = fields;
      if (!isAbsolutePath(dir)) return fail('invalid track request: dir must be an absolute path');
      if (typeof agent !== 'boolean') return fail('invalid track request: agent must be a boolean');
      if (typeof at !== 'string') return fail('invalid track request: at must be a string');
      return { ok: true, request: { v: 1, type: 'track', dir, agent, at } };
    }
    case 'register': {
      const { dirs } = fields;
      if (!Array.isArray(dirs) || !dirs.every(isAbsolutePath)) {
        return fail('invalid register request: dirs must be absolute paths');
      }
      return { ok: true, request: { v: 1, type: 'register', dirs } };
    }
    case 'import': {
      const { dir, at } = fields;
      if (!isAbsolutePath(dir)) return fail('invalid import request: dir must be an absolute path');
      if (typeof at !== 'string') return fail('invalid import request: at must be a string');
      const checked = checkImportPayload(fields);
      if (!checked.ok) return fail(`invalid import request: ${checked.error}`);
      return { ok: true, request: { v: 1, type: 'import', dir, ...checked.payload, at } };
    }
  }
}
