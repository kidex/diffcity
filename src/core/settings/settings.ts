// The user settings file, `<DIFFCITY_HOME>/settings.json` (ADR-030, DC-53).
// It is the only place repo trust lives: a repo's diffcity.config.js is code,
// and the daemon imports it only for a repo root listed in `trustedRepos`
// (ADR-024: reading a repo never runs code the repo configures).
//
// An invalid file is reported and trusts nothing. Writes are atomic (a
// temporary file renamed over the old one) with mode 0600, and keep the
// fields this version does not know.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { RepoNote } from '../model/types.js';

export const SETTINGS_VERSION = 1;

/** The `RepoNote.code` of an untrusted repo that has a diffcity.config.js; the UI words it by this code. */
export const CONFIG_NOT_TRUSTED_CODE = 'config-not-trusted';

/** The RepoSummary note of an untrusted repo that has a diffcity.config.js. */
export const CONFIG_NOT_TRUSTED_NOTE: RepoNote = {
  code: CONFIG_NOT_TRUSTED_CODE,
  text: 'config not loaded: repo not trusted (run diffcity trust)',
};

export interface UserSettings {
  v: typeof SETTINGS_VERSION;
  /** Absolute realpaths of the trusted repo roots. */
  trustedRepos: string[];
  /** The user's rules for every repo (ADR-030); validated rule by rule by src/core/rules. */
  rules?: unknown;
  /** Per repo root (absolute realpath): `{ rules }`, merged after the user's `rules` (ADR-030). */
  repos?: unknown;
  /** Per external tool name: the absolute path of its binary (ADR-030, ADR-032); checked by toolSettingFor. */
  tools?: unknown;
  /** Fields written by another diffcity version, kept as they are. */
  [field: string]: unknown;
}

export type ParsedSettings = { ok: true; settings: UserSettings } | { ok: false; error: string };

/** The settings file is invalid; nothing is written over it. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export function emptySettings(): UserSettings {
  return { v: SETTINGS_VERSION, trustedRepos: [] };
}

/** Parses and validates the text of settings.json. Pure. */
export function parseSettings(text: string): ParsedSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'must be a JSON object' };
  }
  const fields = value as Record<string, unknown>;
  if (fields.v !== SETTINGS_VERSION) return { ok: false, error: `field "v" must be ${String(SETTINGS_VERSION)}` };
  const trusted = fields.trustedRepos ?? [];
  if (!Array.isArray(trusted)) return { ok: false, error: 'field "trustedRepos" must be an array of absolute paths' };
  const entries: unknown[] = trusted;
  if (!entries.every((entry): entry is string => typeof entry === 'string' && isAbsolute(entry))) {
    return { ok: false, error: 'field "trustedRepos" must be an array of absolute paths' };
  }
  return { ok: true, settings: { ...fields, v: SETTINGS_VERSION, trustedRepos: [...entries] } };
}

/** The user's rule lists for one repo, as read: validated by src/core/rules (mergeRules). Plain data. */
export interface UserRuleSettings {
  /** `rules`. */
  settings?: unknown;
  /** `repos.<repoRoot>.rules`. */
  settingsRepo?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The rule lists of settings.json that apply to `repoRoot` (ADR-030). They
 * are not checked here: a bad rule must not untrust every repo, it becomes an
 * `error` check on the Reports instead (src/core/rules). A `repos` that is not
 * an object, or a repo entry that is not one, gives a `settingsRepo` of null,
 * which the rules report as a config error rather than dropping it.
 */
export function ruleSettingsFor(settings: UserSettings, repoRoot: string): UserRuleSettings {
  const result: UserRuleSettings = {};
  if (settings.rules !== undefined) result.settings = settings.rules;
  const { repos } = settings;
  if (repos === undefined) return result;
  if (!isObject(repos)) return { ...result, settingsRepo: null };
  if (!Object.prototype.hasOwnProperty.call(repos, repoRoot)) return result;
  const entry = repos[repoRoot];
  if (!isObject(entry)) return { ...result, settingsRepo: null };
  if (entry.rules !== undefined) result.settingsRepo = entry.rules;
  return result;
}

/**
 * `tools.<name>` of settings.json (ADR-032): unset (the tool is looked up on
 * the PATH), a binary path, or invalid. Like the rules, a bad entry does not
 * invalidate the file; it only stops that tool, which never falls back to the
 * PATH then: the user named a binary and gets that one or none.
 */
export type ToolSetting = { kind: 'unset' } | { kind: 'path'; path: string } | { kind: 'invalid'; message: string };

/** The shape of `tools.<name>`: an absolute path. Pure; toolSetting checks the file. */
export function toolSettingFor(settings: UserSettings, name: string): ToolSetting {
  const { tools } = settings;
  if (tools === undefined) return { kind: 'unset' };
  if (!isObject(tools)) return { kind: 'invalid', message: 'field "tools" must be an object of absolute paths' };
  if (!Object.prototype.hasOwnProperty.call(tools, name)) return { kind: 'unset' };
  const path = tools[name];
  if (typeof path !== 'string' || !isAbsolute(path)) {
    return { kind: 'invalid', message: `field "tools.${name}" must be an absolute path` };
  }
  return { kind: 'path', path };
}

/** Why `path` cannot be a tool's binary, or null when it is an existing, executable regular file. */
export async function toolPathProblem(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return `${path} is not a regular file`;
    await access(path, constants.X_OK);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return `${path} does not exist`;
    if (code === 'EACCES') return `${path} is not executable`;
    return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * `tools.<name>` read from settings.json and checked on disk: an absolute
 * path to an existing, executable regular file. An unreadable or invalid
 * settings file makes every tool invalid: which binary the user wanted is unknown.
 */
export async function readToolSetting(path: string, name: string): Promise<ToolSetting> {
  const read = await readSettings(path);
  if (!read.ok) return { kind: 'invalid', message: read.error };
  const setting = toolSettingFor(read.settings, name);
  if (setting.kind !== 'path') return setting;
  const problem = await toolPathProblem(setting.path);
  return problem === null ? setting : { kind: 'invalid', message: `field "tools.${name}": ${problem}` };
}

/** Reads settings.json; a missing file gives empty settings. Errors name the file. */
export async function readSettings(path: string): Promise<ParsedSettings> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: emptySettings() };
    return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseSettings(text);
  return parsed.ok ? parsed : { ok: false, error: `${path}: ${parsed.error}` };
}

/**
 * Writes settings.json atomically with mode 0600: the content goes to a
 * temporary file in the same directory, which is then renamed over the old
 * file. Creates the directory (mode 0700) when it is missing.
 */
export async function writeSettings(path: string, settings: UserSettings): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      // The umask can only narrow the mode; chmod states it outright.
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // rename keeps the temporary file's mode; this only matters on odd filesystems.
  await chmod(path, 0o600);
}

async function update(path: string, change: (settings: UserSettings) => boolean): Promise<boolean> {
  const read = await readSettings(path);
  if (!read.ok) throw new SettingsError(`${read.error}; fix or remove the file first`);
  if (!change(read.settings)) return false;
  await writeSettings(path, read.settings);
  return true;
}

/** Adds a repo root to `trustedRepos`; false when it was there already. Throws SettingsError on an invalid file. */
export function addTrustedRepo(path: string, root: string): Promise<boolean> {
  return update(path, (settings) => {
    if (settings.trustedRepos.includes(root)) return false;
    settings.trustedRepos.push(root);
    return true;
  });
}

/** Removes a repo root from `trustedRepos`; false when it was not there. Throws SettingsError on an invalid file. */
export function removeTrustedRepo(path: string, root: string): Promise<boolean> {
  return update(path, (settings) => {
    const before = settings.trustedRepos.length;
    settings.trustedRepos = settings.trustedRepos.filter((entry) => entry !== root);
    return settings.trustedRepos.length !== before;
  });
}

export interface TrustCheckOptions {
  /** Called once per distinct invalid content of the file. */
  onInvalid: (message: string) => void;
}

/** Whether a repo root (its realpath) is trusted. */
export type TrustCheck = (repoRoot: string) => Promise<boolean>;

/** The user rule lists of a repo root (its realpath). */
export type RuleSettingsReader = (repoRoot: string) => Promise<UserRuleSettings>;

/**
 * Reads the rule lists from settings.json on every call, like the trust
 * check, so a settings edit takes effect on the next collection. An invalid or
 * unreadable file gives no rules; createTrustCheck reports it.
 */
export function createRuleSettingsReader(path: string): RuleSettingsReader {
  return async (repoRoot) => {
    const read = await readSettings(path);
    return read.ok ? ruleSettingsFor(read.settings, repoRoot) : {};
  };
}

/**
 * A trust check that reads settings.json on every call, so `diffcity trust`
 * takes effect on the next collection without a daemon restart. An invalid
 * or unreadable file trusts nothing.
 */
export function createTrustCheck(path: string, options: TrustCheckOptions): TrustCheck {
  let lastReported: string | null = null;
  return async (repoRoot) => {
    const read = await readSettings(path);
    if (!read.ok) {
      if (read.error !== lastReported) {
        lastReported = read.error;
        options.onInvalid(`${read.error}; no repo is trusted until it is fixed`);
      }
      return false;
    }
    lastReported = null;
    return read.settings.trustedRepos.includes(repoRoot);
  };
}
