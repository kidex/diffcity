// Process execution for the git layer. Everything goes through execFile (no
// shell). Git runs with GIT_OPTIONAL_LOCKS=0 so reading a repo never takes the
// index lock the user's own git commands need (ADR-012).
//
// git is spawned through an absolute path (gitBinary, DC-143). Spawned by its
// bare name, git costs one failed exec attempt per PATH entry before its own;
// on macOS those attempts leave a backlog that the next exec of a third-party
// binary (the CLI's node, gh) pays in one go. A collection of a few hundred
// files spawns over a thousand gits, and the next `diffcity import` or
// `gh pr list` then waited up to 30 s.

import { execFile, spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { absolutePathEntries, isExecutableFile } from '../exec/resolve.js';
import { GUARDED_CONFIG_PATTERN, configEnv, configOverrides, parseScopedConfig } from './guard.js';

export type GitErrorCode = 'not-a-repo' | 'no-commits' | 'no-base' | 'bad-ref' | 'bad-path' | 'git-failed' | 'output-limit';

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
 * command is missing (`code: 'ENOENT'`), fails or exceeds the timeout
 * (`killed: true`). Injected wherever gh is called, so tests can stub it;
 * the real one is the hardened tool runner's gh adapter (src/core/exec/gh.ts, ADR-032).
 */
export type CommandRunner = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

/**
 * Prepended to every git call. A collected repo's own .git/config can name
 * commands git would run; reading a repo must never run any of them (DC-37):
 * - core.fsmonitor: queried on every index read;
 * - core.hooksPath: `add` (and any index write) runs post-index-change; a
 *   hooks directory that cannot exist means no hook is ever found;
 * - filter drivers: overridden per call (see guard.ts);
 * - transports: refused through the environment (see gitEnv).
 * - pager: never used without a terminal; --no-pager makes that explicit.
 * diff.external, diff.<driver>.command and diff.<driver>.textconv are turned
 * off by the diff flags (--no-ext-diff, --no-textconv).
 */
export const STATIC_OVERRIDES: readonly [string, string][] = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', devNull],
];

const SAFE_CONFIG = ['--no-pager', ...STATIC_OVERRIDES.flatMap(([key, value]) => ['-c', `${key}=${value}`])];

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
  // A partial clone fetches missing objects on demand through the repo's own
  // remote settings (uploadpack, core.sshCommand, credential.helper, ...).
  // GIT_NO_LAZY_FETCH stops that on git 2.44+. An empty GIT_ALLOW_PROTOCOL
  // allows no transport at all, overriding any protocol.*.allow config, on
  // every git version and for every subcommand: diffcity never talks to a remote.
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_ALLOW_PROTOCOL = '';
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
  /**
   * Largest stdout accepted, in bytes. Past it git is stopped and the call
   * rejects with a GitError `output-limit`. Defaults to a limit no source file reaches.
   */
  maxOutput?: number;
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

/** git found on the PATH, per PATH value; one lookup however many calls start at once. */
const gitPaths = new Map<string, Promise<string>>();

/**
 * The git to spawn: `<entry>/git` for the first absolute entry of the PATH
 * that holds an executable git, as a shell would find it (not resolved through
 * symlinks, so a Homebrew upgrade behind its link keeps working). Relative and
 * empty entries are skipped: git runs in a repo, whose own ./bin/git must never
 * stand in for it (as for tools, ADR-032). With none, plain `git`, so a missing
 * git fails as it always did. Found once per PATH value; a spawn that reports
 * ENOENT forgets it.
 */
export function gitBinary(pathValue: string | undefined = process.env['PATH']): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('git');
  const key = pathValue ?? '';
  let found = gitPaths.get(key);
  if (found === undefined) {
    found = (async () => {
      for (const dir of absolutePathEntries(pathValue)) {
        const candidate = join(dir, 'git');
        if (await isExecutableFile(candidate)) return candidate;
      }
      return 'git';
    })();
    gitPaths.set(key, found);
  }
  return found;
}

/** Forgets the git found for a PATH value once a spawn of `binary` reported it missing. */
function forgetGitBinary(binary: string, pathValue: string | undefined): void {
  const key = pathValue ?? '';
  const found = gitPaths.get(key);
  // Only the binary that failed: a lookup started since keeps its answer.
  void found?.then((current) => {
    if (current === binary && gitPaths.get(key) === found) gitPaths.delete(key);
  });
}

function spawnGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string | undefined,
  maxOutput: number = GIT_MAX_BUFFER,
): Promise<GitResult> {
  const pathValue = process.env['PATH'];
  return gitBinary(pathValue).then((binary) => runGit(binary, pathValue, cwd, args, env, input, maxOutput));
}

function runGit(
  binary: string,
  pathValue: string | undefined,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input: string | undefined,
  maxOutput: number,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        env,
        encoding: 'buffer',
        maxBuffer: maxOutput,
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
        if (error.code === 'ENOENT') forgetGitBinary(binary, pathValue);
        const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' : 'git-failed';
        reject(new GitError(code, `git ${args.join(' ')} failed: ${error.message}`, { cause: error }));
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
 * Unless the subcommand cannot run a filter driver, the repo's filter
 * settings are read first and overridden for this call (guard.ts),
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
  return spawnGit(cwd, args, env, options.input, options.maxOutput);
}

/**
 * Runs git and hands stdout to `onChunk` as it arrives, never holding it in
 * memory, so output of any size can be hashed (a blob of several GB, say).
 * Resolves with the exit code and stderr; rejects when git cannot be spawned
 * or `onChunk` throws. Only for subcommands that cannot run a filter driver
 * (`cat-file blob`, `ls-tree`, ...): the config lookup gitRaw does for the
 * others is not made here, and a subcommand that needs it throws.
 */
export function gitStream(
  cwd: string,
  args: readonly string[],
  onChunk: (chunk: Buffer) => void,
): Promise<{ exitCode: number; stderr: string }> {
  if (mayRunFilters(args)) throw new GitError('git-failed', `git ${args.join(' ')} cannot be streamed: it may run a filter driver`);
  const pathValue = process.env['PATH'];
  return gitBinary(pathValue).then((binary) => streamGit(binary, pathValue, cwd, args, onChunk));
}

function streamGit(
  binary: string,
  pathValue: string | undefined,
  cwd: string,
  args: readonly string[],
  onChunk: (chunk: Buffer) => void,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...SAFE_CONFIG, ...args], { cwd, env: gitEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    let stderrSize = 0;
    let failure: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      // Diagnostics only: keep the first 64 KiB.
      if (stderrSize < 65_536) {
        stderr.push(chunk);
        stderrSize += chunk.length;
      }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure !== null) return;
      try {
        onChunk(chunk);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') forgetGitBinary(binary, pathValue);
      reject(new GitError('git-failed', `git ${args.join(' ')} failed: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (failure !== null) reject(failure);
      else resolve({ exitCode: code ?? 1, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
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
