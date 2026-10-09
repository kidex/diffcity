// The confirmed-action runner (ADR-029): a write that starts a program is two
// requests. The preview computes exactly what would run and returns a token
// bound to it; the run presents the token, which is single-use and valid for
// CONFIRM_TTL_MS. The token is random, kept only in memory (a daemon restart
// voids every token) and looked up by its hash. A token is consumed by the
// first request that presents it, whatever that request's outcome: a refused
// run needs a new preview.

import { createHash, randomBytes } from 'node:crypto';

export const CONFIRM_TTL_MS = 2 * 60 * 1000;

/** Tokens kept at once; past it the oldest is dropped. */
export const CONFIRM_MAX_PENDING = 64;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface ConfirmedActions<B> {
  /** A new token bound to `binding`. */
  issue(binding: B): string;
  /** The binding of a live token, consuming it; null for anything else (unknown, used, expired, malformed). */
  take(token: unknown): B | null;
  /** Tokens issued and not yet taken or expired. */
  readonly pending: number;
}

export interface ConfirmOptions {
  /** Milliseconds since the epoch; Date.now by default. */
  now?: () => number;
  ttlMs?: number;
  max?: number;
}

const keyOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export function createConfirmedActions<B>(options: ConfirmOptions = {}): ConfirmedActions<B> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CONFIRM_TTL_MS;
  const max = options.max ?? CONFIRM_MAX_PENDING;
  // Insertion order is issue order: the first entry is the oldest.
  const tokens = new Map<string, { binding: B; expiresAt: number }>();

  const sweep = (): void => {
    const at = now();
    for (const [key, entry] of tokens) if (entry.expiresAt <= at) tokens.delete(key);
  };

  return {
    issue(binding) {
      sweep();
      while (tokens.size >= max) {
        const oldest = tokens.keys().next();
        if (oldest.done === true) break;
        tokens.delete(oldest.value);
      }
      const token = randomBytes(32).toString('base64url');
      tokens.set(keyOf(token), { binding, expiresAt: now() + ttlMs });
      return token;
    },
    take(token) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return null;
      const key = keyOf(token);
      const entry = tokens.get(key);
      tokens.delete(key);
      if (entry === undefined || entry.expiresAt <= now()) return null;
      return entry.binding;
    },
    get pending() {
      sweep();
      return tokens.size;
    },
  };
}
