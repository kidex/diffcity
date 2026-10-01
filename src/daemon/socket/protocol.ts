// Socket protocol v1 (ADR-016): one request per connection, a JSON line of at
// most 64 KiB; the response is one JSON line. This module validates a request
// line into the typed SocketRequest from src/core/model/types.ts.

import { isAbsolute } from 'node:path';
import type { SocketRequest, SocketRequestType } from '../../core/model/types.js';

/** Longest request line, in bytes, without the newline. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** A connection is closed if the exchange is not over within this time. */
export const REQUEST_TIMEOUT_MS = 5000;

export const PROTOCOL_VERSION = 1;

const REQUEST_TYPES: ReadonlySet<string> = new Set<SocketRequestType>(['ping', 'track', 'register', 'shutdown']);

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
  }
}
