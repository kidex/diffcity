// Process execution for the git layer. Everything goes through execFile (no
// shell). Git runs with GIT_OPTIONAL_LOCKS=0 so reading a repo never takes the
// index lock the user's own git commands need (ADR-012).

import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { GUARDED_CONFIG_PATTERN, configEnv, configOverrides, parseScopedConfig } from './guard.js';

export type GitErrorCode = 'not-a-repo' | 'no-commits' | 'no-base' | 'bad-ref' | 'bad-path' | 'git-failed';

export class GitError extends Error {
  readonly code: GitErrorCode;

  constructor(code: GitErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitError';
    this.code = code;
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
}

/**
 * Runs an external command and resolves with its stdout; rejects when the
 * command is missing (`code: 'ENOENT'`), exits non-zero or exceeds the timeout.
 * Injected wherever an optional tool such as `gh` is called, so tests can stub it.
 */
export type CommandRunner = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

export const defaultRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(error instanceof Error ? error : new Error(`${file} failed`, { cause: error }));
      },
    );
  });

/**
 * Prepended to every git call. A collected repo's own .git/config can name
 * commands git would run; reading a repo must never run any of them (DC-37):
 * - core.fsmonitor: queried on every index read;
 * - core.hooksPath: `add` (and any index write) runs post-index-change; a
 *   hooks directory that cannot exist means no hook is ever found;
 * - protocol.allow: a partial clone fetches missing objects on demand through
 *   the repo's remote (uploadpack, core.sshCommand, credential.helper, ...).
 *   GIT_NO_LAZY_FETCH (gitEnv) stops the fetch on git 2.44+; refusing every
 *   transport also covers older git. Repo-set `protocol.<name>.allow` and
 *   filter drivers are overridden per call (see guard.ts).
 * - pager: never used without a terminal; --no-pager makes that explicit.
 * diff.external, diff.<driver>.command and diff.<driver>.textconv are turned
 * off by the diff flags (--no-ext-diff, --no-textconv).
 */
const SAFE_CONFIG = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${devNull}`,
  '-c',
  'protocol.allow=never',
];

/** Big enough for any single source file or file list we read. */
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Variables that would redirect git to another repo, index or work tree.
 * They leak in when diffcity runs inside a git hook; every call passes cwd explicitly instead.
 */
const REPO_LOCATION_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]);

export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!REPO_LOCATION_VARS.has(name)) env[name] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  return env;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface GitCallOptions {
  /** Extra variables for this call only, applied after gitEnv() (e.g. a temporary GIT_INDEX_FILE). */
  env?: Record<string, string>;
  /** Written to git's stdin. */
  input?: string;
}

/**
 * Subcommands that never pass working tree content through a filter driver
 * (`cat-file` only with --filters or --textconv), so they skip the config
 * lookup gitRaw does for every other call.
 */
const NO_FILTER_SUBCOMMANDS = new Set(['rev-parse', 'merge-base', 'rev-list', 'symbolic-ref', 'ls-tree', 'cat-file', 'config']);

/** First non-option argument, skipping `-c <name>=<value>` pairs. */
function subcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') i++;
    else if (arg !== undefined && !arg.startsWith('-')) return arg;
  }
  return undefined;
}

function mayRunFilters(args: readonly string[]): boolean {
  const name = subcommand(args);
  if (name === undefined || !NO_FILTER_SUBCOMMANDS.has(name)) return true;
  return args.some((arg) => arg.startsWith('--filters') || arg.startsWith('--textconv'));
}

function spawnGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv, input: string | undefined): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        env,
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stderrText = stderr.toString('utf8');
        if (error === null) {
          resolve({ stdout, stderr: stderrText, exitCode: 0 });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ stdout, stderr: stderrText, exitCode: error.code });
          return;
        }
        reject(new GitError('git-failed', `git ${args.join(' ')} failed: ${error.message}`, { cause: error }));
      },
    );
    // git may exit before reading all of its input (e.g. it fails at startup);
    // the write then fails with EPIPE, which the exit code already reports.
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') return;
      reject(new GitError('git-failed', `git ${args.join(' ')} failed writing stdin: ${error.message}`, { cause: error }));
    });
    child.stdin?.end(input ?? '');
  });
}

/**
 * Runs git and returns stdout as bytes plus the exit code; rejects only when git cannot be spawned.
 *
 * Unless the subcommand cannot run a filter driver, the repo's filter and
 * protocol settings are read first and overridden for this call (guard.ts),
 * so a filter the repo configures never runs. When that lookup fails (a
 * broken config file, say) git is not run and the lookup's failure is returned.
 */
export async function gitRaw(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...gitEnv(), ...options.env };
  if (mayRunFilters(args)) {
    const lookup = await spawnGit(cwd, ['config', '--show-scope', '-z', '--get-regexp', GUARDED_CONFIG_PATTERN], env, undefined);
    // Exit code 1: no matching key.
    if (lookup.exitCode !== 0 && lookup.exitCode !== 1) {
      return { stdout: Buffer.alloc(0), stderr: lookup.stderr, exitCode: lookup.exitCode };
    }
    Object.assign(env, configEnv(configOverrides(parseScopedConfig(lookup.stdout.toString('utf8'))), env));
  }
  return spawnGit(cwd, args, env, options.input);
}

/** Runs git; resolves with stdout as UTF-8, rejects with a GitError on a non-zero exit. */
export async function git(cwd: string, args: readonly string[], options: GitCallOptions = {}): Promise<string> {
  const result = await gitRaw(cwd, args, options);
  if (result.exitCode !== 0) {
    throw new GitError('git-failed', `git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.toString('utf8');
}

/** Splits NUL-terminated `-z` output. */
export function splitNul(output: string): string[] {
  const parts = output.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

/** Refs and paths come from users; one starting with `-` would be read as an option. */
export function assertNotOption(ref: string, what: string): void {
  if (ref.startsWith('-')) throw new GitError('bad-ref', `invalid ${what}: ${ref}`);
}

/** Sha of `ref` as a commit, or null when it does not resolve to one. */
export async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  assertNotOption(ref, 'ref');
  const result = await gitRaw(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString('utf8').trim();
}
