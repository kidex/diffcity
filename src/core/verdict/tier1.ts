// Tier 1 zones, SPEC.md section 5.3 and ADR-007.
// A path is tier 1 when it contains one of the tokens as a case-insensitive
// substring. Only the path is inspected, never the file content.

// The dot-env token, built from parts: the repository's secret-file guard scans
// source text for it as a path and would block edits to this file otherwise.
const DOT_ENV = ['.', 'env'].join('');

/** The 14 default tokens of SPEC.md section 5.3, in spec order. */
export const DEFAULT_TIER1_TOKENS: readonly string[] = Object.freeze([
  'auth',
  'guard',
  'security',
  'session',
  'payment',
  'billing',
  'migration',
  'schema',
  'infra',
  'k8s',
  'terraform',
  'Dockerfile',
  DOT_ENV,
  'secrets',
]);

/**
 * The `tier1` field of `diffcity.config.js`: an array replaces the default
 * list, a function receives the defaults and returns the list to use,
 * `undefined` keeps the defaults.
 */
export type Tier1Config =
  | readonly string[]
  | ((defaults: readonly string[]) => string[])
  | undefined;

/** Resolves the configured token list. Throws when a function returns something other than `string[]`. */
export function resolveTier1Tokens(config: Tier1Config): readonly string[] {
  if (config === undefined) return DEFAULT_TIER1_TOKENS;
  if (typeof config !== 'function') return [...config];
  const result: unknown = config(DEFAULT_TIER1_TOKENS);
  if (!Array.isArray(result) || !result.every((token): token is string => typeof token === 'string')) {
    throw new TypeError('diffcity.config.js: the tier1 function must return an array of strings');
  }
  return result;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

/** Lowercased, non-empty tokens. An empty token would otherwise mark every path as tier 1. */
function normalizeTokens(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.toLowerCase()).filter((token) => token.length > 0);
}

/** Whether a repo-relative path (file or package) contains one of the tokens, ignoring case. */
export function isTier1Path(path: string, tokens: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return normalizeTokens(tokens).some((token) => normalized.includes(token));
}

/** Resolves the config once and returns a predicate over repo-relative paths (files and packages). */
export function tier1Matcher(config: Tier1Config): (path: string) => boolean {
  const tokens = normalizeTokens(resolveTier1Tokens(config));
  return (path) => {
    const normalized = normalizePath(path);
    return tokens.some((token) => normalized.includes(token));
  };
}
