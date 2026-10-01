// Config overrides that stop a repo from making git run commands it names
// itself (DC-37). A collected repo is untrusted: its .git/config (and anything
// it includes) can point filter drivers at arbitrary programs and select them
// for any path through .gitattributes. git runs a clean filter whenever it
// hashes a working tree file, which `git diff` against the working tree does.
//
// Filter driver settings that come from the repo (local or worktree scope) are
// replaced on every call by the value from the user's own config (system,
// global, command line), or disabled when the user defines none. A filter the
// user installed (git-lfs, say) keeps working; a repo cannot add or redirect one.

/** Config scopes the user controls. Anything else (local, worktree, unknown) is the repo's. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/** Filter driver variables that name a command, plus `required`, which turns a disabled driver into a fatal error. */
const FILTER_VARS = new Set(['clean', 'smudge', 'process', 'required']);

/** The `git config --get-regexp` pattern whose entries configOverrides inspects. */
export const GUARDED_CONFIG_PATTERN = '^(filter|protocol)\\.';

export interface ScopedConfigEntry {
  scope: string;
  /** Section and variable lowercased by git, subsection as written. */
  key: string;
  /** `null` for a bare boolean key (`[filter "x"] required`). */
  value: string | null;
}

/** Parses `git config --show-scope -z --get-regexp` output: `<scope>\0<key>\n<value>\0` per entry. */
export function parseScopedConfig(output: string): ScopedConfigEntry[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: ScopedConfigEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i] ?? '';
    const record = tokens[i + 1] ?? '';
    const newline = record.indexOf('\n');
    entries.push(
      newline < 0
        ? { scope, key: record, value: null }
        : { scope, key: record.slice(0, newline), value: record.slice(newline + 1) },
    );
  }
  return entries;
}

/** `[section, subsection, variable]`, or null for a key without a subsection. */
function splitKey(key: string): [string, string, string] | null {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0 || last <= first) return null;
  return [key.slice(0, first), key.slice(first + 1, last), key.slice(last + 1)];
}

/** Value to restore for a filter variable: what the user's own config says, else disabled. */
function trustedValue(variable: string, value: string | null | undefined): string {
  if (variable === 'required') return value === undefined ? 'false' : (value ?? 'true');
  // A bare `clean` key is a config error in git; an empty command disables the driver.
  return value ?? '';
}

/**
 * Overrides, as `[key, value]` pairs in order, for config entries listed in
 * scope order (as `git config --show-scope --get-regexp` prints them):
 * - every `filter.<name>.<clean|smudge|process|required>` set by the repo gets
 *   the user's own value back (the last one from a trusted scope), or an empty
 *   command / `false` when the user has none;
 * - every `protocol.<name>.allow` becomes `never`: diffcity never talks to a
 *   remote, and a repo could otherwise allow a dangerous transport (`ext::`)
 *   for the lazy fetch of a partial clone.
 */
export function configOverrides(entries: readonly ScopedConfigEntry[]): [string, string][] {
  const filterKeys = new Map<string, { repoSet: boolean; trusted: string | null | undefined }>();
  const protocols = new Set<string>();
  for (const entry of entries) {
    const parts = splitKey(entry.key);
    if (parts === null) continue;
    const [section, , variable] = parts;
    if (section === 'protocol' && variable === 'allow') {
      protocols.add(entry.key);
    } else if (section === 'filter' && FILTER_VARS.has(variable)) {
      const state = filterKeys.get(entry.key) ?? { repoSet: false, trusted: undefined };
      if (TRUSTED_SCOPES.has(entry.scope)) state.trusted = entry.value;
      else state.repoSet = true;
      filterKeys.set(entry.key, state);
    }
  }

  const overrides: [string, string][] = [];
  for (const [key, state] of filterKeys) {
    if (!state.repoSet) continue;
    overrides.push([key, trustedValue(splitKey(key)?.[2] ?? '', state.trusted)]);
  }
  for (const key of protocols) overrides.push([key, 'never']);
  return overrides;
}

/**
 * Environment that adds `overrides` to git's config through
 * GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>, after any the
 * caller already set. Unlike `-c`, the key is never split on `=`, so a filter
 * name containing one cannot dodge its override.
 */
export function configEnv(
  overrides: readonly [string, string][],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (overrides.length === 0) return {};
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const result: Record<string, string> = { GIT_CONFIG_COUNT: String(start + overrides.length) };
  overrides.forEach(([key, value], i) => {
    result[`GIT_CONFIG_KEY_${String(start + i)}`] = key;
    result[`GIT_CONFIG_VALUE_${String(start + i)}`] = value;
  });
  return result;
}
