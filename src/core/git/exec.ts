// Process execution for the git layer. Everything goes through execFile (no
// shell). Git runs with GIT_OPTIONAL_LOCKS=0 so reading a repo never takes the
// index lock the user's own git commands need (ADR-012).

import { execFile } from 'node:child_process';

export type GitErrorCode = 'not-a-repo' | 'no-commits' | 'no-base' | 'bad-ref' | 'git-failed';

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
  return env;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/** Runs git and returns stdout as bytes plus the exit code; rejects only when git cannot be spawned. */
export function gitRaw(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
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
  });
}

/** Runs git; resolves with stdout as UTF-8, rejects with a GitError on a non-zero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await gitRaw(cwd, args);
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
