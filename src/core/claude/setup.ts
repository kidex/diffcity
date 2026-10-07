// `diffcity setup-claude` (ADR-037): plans and applies the two files diffcity
// owns in a Claude Code configuration, the `/code-review` command file and the
// Stop hook entry in `settings.json`, plus a one-time backup of that
// `settings.json`. Planning reads only; nothing is written when any file is
// refused, so a refusal leaves both files as they were. Writes go through a
// temporary file in the same directory and a rename; an existing file that is
// a symbolic link is written at its target, so the link stays. setup writes no
// daemon settings.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { COMMAND_FILE_NAME, COMMAND_MARKER, commandFileText, isDiffcityCommandFile, recordedCli } from './command-file.js';
import { hookCommand } from './hook-command.js';
import { addStopHook, removeStopHook } from './settings.js';

/** The Claude Code version the command file and the settings format were checked against. */
export const CLAUDE_CODE_CHECKED_VERSION = '2.1.288';

/** Suffix of the one-time backup of `settings.json`. */
export const BACKUP_SUFFIX = '.diffcity-backup';

export interface ClaudeTarget {
  /** `user`: the Claude Code configuration directory; `repo`: `<repo>/.claude`. */
  scope: 'user' | 'repo';
  /** The directory holding `commands/` and `settings.json`. */
  dir: string;
  commandFile: string;
  settingsFile: string;
  backupFile: string;
}

/** The files of a configuration directory (`~/.claude`, `$CLAUDE_CONFIG_DIR` or `<repo>/.claude`). */
export function claudeTarget(scope: ClaudeTarget['scope'], dir: string): ClaudeTarget {
  const settingsFile = join(dir, 'settings.json');
  return { scope, dir, commandFile: join(dir, 'commands', COMMAND_FILE_NAME), settingsFile, backupFile: `${settingsFile}${BACKUP_SUFFIX}` };
}

export type FileAction = 'create' | 'update' | 'unchanged' | 'delete' | 'absent' | 'kept';

export interface PlannedFile {
  path: string;
  kind: 'command' | 'settings';
  action: FileAction;
  /** The new content, for `create` and `update`. */
  text?: string;
}

export interface SetupPlan {
  target: ClaudeTarget;
  /** The hook command added (install) or looked for first (remove). */
  hookCommand: string;
  files: PlannedFile[];
  /** The backup to write before `settings.json` changes; null when none is needed. */
  backup: { from: string; to: string } | null;
}

export type PlanResult = { ok: true; plan: SetupPlan } | { ok: false; reason: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The file's text, or null when it does not exist. */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readBoth(target: ClaudeTarget): Promise<{ ok: true; command: string | null; settings: string | null } | { ok: false; reason: string }> {
  const read = async (path: string): Promise<{ ok: true; text: string | null } | { ok: false; reason: string }> => {
    try {
      return { ok: true, text: await readOptional(path) };
    } catch (error) {
      return { ok: false, reason: `cannot read ${path}: ${messageOf(error)}` };
    }
  };
  const command = await read(target.commandFile);
  if (!command.ok) return command;
  const settings = await read(target.settingsFile);
  if (!settings.ok) return settings;
  return { ok: true, command: command.text, settings: settings.text };
}

async function backupFor(target: ClaudeTarget, settingsExisted: boolean): Promise<SetupPlan['backup']> {
  if (!settingsExisted || (await exists(target.backupFile))) return null;
  return { from: target.settingsFile, to: target.backupFile };
}

/** What setup would change to install the command file and the Stop hook for invocation `cli`. */
export async function planInstall(target: ClaudeTarget, cli: string): Promise<PlanResult> {
  const read = await readBoth(target);
  if (!read.ok) return read;
  const command = hookCommand(cli);

  const files: PlannedFile[] = [];
  const text = commandFileText(cli);
  if (read.command === null) files.push({ path: target.commandFile, kind: 'command', action: 'create', text });
  else if (!isDiffcityCommandFile(read.command)) {
    return {
      ok: false,
      reason: `${target.commandFile} exists and was not written by diffcity (no ${COMMAND_MARKER} line after its frontmatter); move it away and run setup-claude again`,
    };
  } else if (read.command === text) files.push({ path: target.commandFile, kind: 'command', action: 'unchanged' });
  else files.push({ path: target.commandFile, kind: 'command', action: 'update', text });

  const edit = addStopHook(read.settings, command);
  if (!edit.ok) return { ok: false, reason: `${target.settingsFile} ${edit.reason}; fix it or move it away, nothing was written` };
  if (!edit.changed) files.push({ path: target.settingsFile, kind: 'settings', action: 'unchanged' });
  else files.push({ path: target.settingsFile, kind: 'settings', action: read.settings === null ? 'create' : 'update', text: edit.text });

  const settingsChanges = edit.changed && read.settings !== null;
  return { ok: true, plan: { target, hookCommand: command, files, backup: settingsChanges ? await backupFor(target, true) : null } };
}

/**
 * What setup would change to remove what diffcity wrote: the command file when
 * it carries the marker, and every Stop hook whose command is the one of `cli`
 * or the one recorded in diffcity's command file.
 */
export async function planRemove(target: ClaudeTarget, cli: string): Promise<PlanResult> {
  const read = await readBoth(target);
  if (!read.ok) return read;
  const command = hookCommand(cli);
  const commands = [command];
  const files: PlannedFile[] = [];

  if (read.command === null) files.push({ path: target.commandFile, kind: 'command', action: 'absent' });
  else if (isDiffcityCommandFile(read.command)) {
    files.push({ path: target.commandFile, kind: 'command', action: 'delete' });
    const recorded = recordedCli(read.command);
    if (recorded !== null && recorded !== cli) commands.push(hookCommand(recorded));
  } else files.push({ path: target.commandFile, kind: 'command', action: 'kept' });

  const edit = removeStopHook(read.settings, commands);
  if (!edit.ok) return { ok: false, reason: `${target.settingsFile} ${edit.reason}; fix it or move it away, nothing was written` };
  if (read.settings === null) files.push({ path: target.settingsFile, kind: 'settings', action: 'absent' });
  else if (!edit.changed) files.push({ path: target.settingsFile, kind: 'settings', action: 'unchanged' });
  else files.push({ path: target.settingsFile, kind: 'settings', action: 'update', text: edit.text });

  return { ok: true, plan: { target, hookCommand: command, files, backup: edit.changed ? await backupFor(target, true) : null } };
}

/** The path to write: the target of an existing symbolic link, the path itself otherwise. */
async function writePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

/** Writes `text` to `path` through a temporary file and a rename, keeping an existing file's mode. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const target = await writePath(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dir, `.${basename(target)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Applies a plan: the backup first, then every file that changes. */
export async function applyPlan(plan: SetupPlan): Promise<void> {
  if (plan.backup !== null) {
    try {
      await copyFile(plan.backup.from, plan.backup.to, constants.COPYFILE_EXCL);
    } catch (error) {
      // Written meanwhile: the first backup stays.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  for (const file of plan.files) {
    if ((file.action === 'create' || file.action === 'update') && file.text !== undefined) await writeFileAtomic(file.path, file.text);
    else if (file.action === 'delete') await unlink(file.path);
  }
}
