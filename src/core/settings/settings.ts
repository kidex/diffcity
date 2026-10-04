// The user settings file, `<DIFFCITY_HOME>/settings.json` (ADR-030, DC-53).
// It is the only place repo trust lives: a repo's diffcity.config.js is code,
// and the daemon imports it only for a repo root listed in `trustedRepos`
// (ADR-024: reading a repo never runs code the repo configures).
//
// An invalid file is reported and trusts nothing. Writes are atomic (a
// temporary file renamed over the old one) with mode 0600, and keep the
// fields this version does not know.

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
