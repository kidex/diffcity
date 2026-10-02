// `diffcity trust [<dir>]`, `diffcity trust --list`, `diffcity trust --remove [<dir>]`
// (ADR-030). A repo's diffcity.config.js is JavaScript: the daemon imports it
// only for a repo root listed in settings.json (ADR-024). This command is the
// one way into that list; the repo itself can never put itself there.
//
// The root stored is the realpath of the main working tree, the same path the
// daemon identifies the repo by, so trusting from a subdirectory, a linked
// worktree or a symlink trusts the same repo. Takes effect on the repo's next
// collection; the daemon need not restart.

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { identifyRepo } from '../core/changes/identity.js';
import { ensureHome, homePaths, resolveHome } from '../core/home.js';
import { addTrustedRepo, readSettings, removeTrustedRepo } from '../core/settings/index.js';

export interface TrustCommandOptions {
  list?: boolean;
  remove?: boolean;
}

export interface TrustDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The root to remove: the repo's root, or, for a directory that is no longer
 * a repo (moved or deleted), the path itself when it is in the list.
 */
async function rootToRemove(dir: string, trusted: readonly string[]): Promise<string> {
  try {
    return (await identifyRepo(dir)).path;
  } catch (error) {
    const real = await realpath(dir).catch(() => dir);
    if (trusted.includes(real)) return real;
    throw error;
  }
}

/** Runs the command; resolves with the process exit code (0 or 1). */
export async function runTrust(dirArg: string | undefined, options: TrustCommandOptions, deps: TrustDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity trust: ${message}\n`);
    return 1;
  };
  const list = options.list === true;
  const remove = options.remove === true;
  if (list && remove) return fail('--list and --remove cannot be used together');
  if (list && dirArg !== undefined) return fail('--list takes no directory');

  let file: string;
  let home: string;
  try {
    home = resolveHome(deps.env ?? process.env);
    file = homePaths(home).settings;
  } catch (error) {
    return fail(messageOf(error));
  }

  const read = await readSettings(file);
  if (!read.ok) return fail(read.error);

  if (list) {
    const roots = read.settings.trustedRepos;
    io.stdout(roots.length === 0 ? 'no trusted repos\n' : roots.map((root) => `${root}\n`).join(''));
    return 0;
  }

  const dir = resolve(deps.cwd ?? process.cwd(), dirArg ?? '.');
  try {
    if (remove) {
      const root = await rootToRemove(dir, read.settings.trustedRepos);
      io.stdout(`${(await removeTrustedRepo(file, root)) ? 'removed' : 'not trusted'} ${root}\n`);
      return 0;
    }
    const root = (await identifyRepo(dir)).path;
    await ensureHome(home);
    io.stdout(`${(await addTrustedRepo(file, root)) ? 'trusted' : 'already trusted'} ${root}\n`);
    return 0;
  } catch (error) {
    return fail(messageOf(error));
  }
}
