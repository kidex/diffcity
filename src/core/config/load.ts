// Loads and validates `diffcity.config.js` from the repo root (ADR-012, ADR-007).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_FILE_NAME = 'diffcity.config.js';

/** Extends or narrows the default tier 1 tokens (ADR-007). */
export type Tier1Fn = (defaults: string[]) => string[];

export interface DiffcityConfig {
  /** Base branch or ref, used when `--base` is not given. */
  base?: string;
  /** `string[]` replaces the default tier 1 tokens; a function receives them and returns the list to use. */
  tier1?: string[] | Tier1Fn;
}

export class ConfigError extends Error {
  /** The offending field, when the error is about a single field. */
  readonly field: string | undefined;

  constructor(message: string, field?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfigError';
    this.field = field;
  }
}

const KNOWN_FIELDS = new Set(['base', 'tier1']);

function fieldError(field: string, problem: string): ConfigError {
  return new ConfigError(`${CONFIG_FILE_NAME}: field "${field}" ${problem}`, field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validates the default export of a config module. */
export function validateConfig(value: unknown): DiffcityConfig {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: the default export must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) throw fieldError(key, 'is not a known field (allowed: base, tier1)');
  }

  const config: DiffcityConfig = {};
  const { base, tier1 } = value;

  if (base !== undefined) {
    if (typeof base !== 'string' || base.trim() === '') throw fieldError('base', 'must be a non-empty string');
    config.base = base;
  }

  if (tier1 !== undefined) {
    if (Array.isArray(tier1)) {
      const tokens: unknown[] = tier1;
      if (!tokens.every((token): token is string => typeof token === 'string')) {
        throw fieldError('tier1', 'must be an array of strings or a function');
      }
      // An empty token is a substring of every path and would make the whole repo tier 1.
      if (tokens.some((token) => token.trim() === '')) {
        throw fieldError('tier1', 'must not contain empty strings');
      }
      config.tier1 = [...tokens];
    } else if (typeof tier1 === 'function') {
      // The shape of a user function cannot be checked before it is called.
      config.tier1 = tier1 as Tier1Fn;
    } else {
      throw fieldError('tier1', 'must be an array of strings or a function');
    }
  }

  return config;
}

export interface LoadConfigOptions {
  /**
   * Whether the repo's config may run. The file is JavaScript, so importing it
   * runs the repo's code (ADR-024): the daemon passes true only for a repo
   * root listed in settings.json (ADR-030); `diffcity diff`, run by hand in
   * the repo, passes true. Required, so no caller decides by omission.
   */
  trusted: boolean;
}

/**
 * Loads `diffcity.config.js` from `repoRoot` through a dynamic `import()` and
 * validates its default export. A missing file gives an empty config, and so
 * does an untrusted repo: its file is then neither read nor imported.
 */
export async function loadConfig(repoRoot: string, options: LoadConfigOptions): Promise<DiffcityConfig> {
  if (!options.trusted) return {};
  const file = join(repoRoot, CONFIG_FILE_NAME);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  // The query string busts the ESM cache so a long-running daemon sees edits.
  const url = `${pathToFileURL(file).href}?mtime=${String(mtimeMs)}`;
  let mod: Record<string, unknown>;
  try {
    // The user's own config file, never another diffcity layer; the URL is
    // computed for the cache-busting query, so it cannot be a string literal.
    // eslint-disable-next-line no-restricted-syntax
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`failed to load ${CONFIG_FILE_NAME}: ${reason}`, undefined, { cause: error });
  }

  if (!('default' in mod)) throw new ConfigError(`${CONFIG_FILE_NAME}: a default export is required`);
  return validateConfig(mod.default);
}
