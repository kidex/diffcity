// Temporary git repositories for tests (ADR-014).
//
// Every repo lives in its own directory under os.tmpdir(). Git runs with an
// invented local identity and ignores the global and system git config, so
// tests behave the same on every machine. Paths inside a `.git` directory are
// refused, so a nested `.git` can never end up in a fixture or a commit.

import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** File path (relative to the repo root, `/`-separated) to content; `null` deletes the file. */
export type FileTree = Record<string, string | null>;

export interface CreateRepoOptions {
  /** Initial tree, committed on the initial branch. Omit for an empty repo with no commits. */
  files?: FileTree;
  /** Message of the initial commit. */
  message?: string;
  /** Name of the initial branch. Defaults to `main`. */
  initialBranch?: string;
  /**
   * Directory name of the working tree (meta.repo is the root's basename). The
   * repo is created as a child named so inside a fresh temp directory; cleanup
   * removes both. Defaults to a random `diffcity-repo-*` directory.
   */
  name?: string;
}

export interface TempRepo {
  /** Absolute path of the working tree. */
  readonly dir: string;
  /** Runs git in the repo with the isolated environment; returns stdout without trailing newlines. */
  git(...args: string[]): Promise<string>;
  /** Writes (or deletes, for `null`) files in the working tree without staging them. */
  write(files: FileTree): Promise<void>;
  /** Applies `files` (if given), stages everything and commits. Returns the new commit sha. */
  commit(message: string, files?: FileTree): Promise<string>;
  /** Creates a branch from `from` (default: HEAD) and checks it out. */
  branch(name: string, from?: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  /** Sha of HEAD. */
  head(): Promise<string>;
  currentBranch(): Promise<string>;
  /** `git status --porcelain` output, untracked files included. */
  status(): Promise<string>;
  /** Removes the whole temp directory. */
  cleanup(): Promise<void>;
}

export const AUTHOR_NAME = 'Sample Author';
export const AUTHOR_EMAIL = 'author@example.invalid';

/** 2026-01-01T00:00:00Z; each commit advances the clock by one minute. */
const EPOCH_SECONDS = 1_767_225_600;

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Drop inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ... set by hooks).
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_AUTHOR_NAME = AUTHOR_NAME;
  env.GIT_AUTHOR_EMAIL = AUTHOR_EMAIL;
  env.GIT_COMMITTER_NAME = AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = AUTHOR_EMAIL;
  return env;
}

function resolveInside(root: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error(`Path must be relative to the repo: ${relPath}`);
  const normalized = normalize(relPath);
  const segments = normalized.split(sep);
  if (segments[0] === '..') throw new Error(`Path is outside the repo: ${relPath}`);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    throw new Error(`Refusing to write inside a .git directory: ${relPath}`);
  }
  return join(root, normalized);
}

function assertDirName(name: string): void {
  const valid = name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name) && name.toLowerCase() !== '.git';
  if (!valid) throw new Error(`Repo name must be a single directory name: ${name}`);
}

export async function createRepo(options: CreateRepoOptions = {}): Promise<TempRepo> {
  if (options.name !== undefined) assertDirName(options.name);
  const tempRoot = await mkdtemp(join(tmpdir(), 'diffcity-repo-'));
  const dir = options.name === undefined ? tempRoot : join(tempRoot, options.name);
  if (dir !== tempRoot) await mkdir(dir);
  const baseEnv = isolatedEnv();
  let clock = 0;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, env: baseEnv, encoding: 'utf8' });
    return stdout.replace(/\n+$/, '');
  }

  async function write(files: FileTree): Promise<void> {
    const targets = Object.entries(files).map(([path, content]) => [resolveInside(dir, path), content] as const);
    for (const [target, content] of targets) {
      if (content === null) {
        await rm(target, { force: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
    }
  }

  async function commit(message: string, files?: FileTree): Promise<string> {
    if (files) await write(files);
    await git('add', '--all');
    const date = `${String(EPOCH_SECONDS + clock * 60)} +0000`;
    clock += 1;
    await execFileAsync('git', ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', message], {
      cwd: dir,
      env: { ...baseEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git('rev-parse', 'HEAD');
  }

  const repo: TempRepo = {
    dir,
    git,
    write,
    commit,
    async branch(name, from) {
      await git('checkout', '--quiet', '-b', name, ...(from === undefined ? [] : [from]));
    },
    async checkout(ref) {
      await git('checkout', '--quiet', ref);
    },
    head: () => git('rev-parse', 'HEAD'),
    currentBranch: () => git('symbolic-ref', '--short', 'HEAD'),
    status: () => git('status', '--porcelain'),
    async cleanup() {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };

  try {
    await git('init', '--quiet', '--initial-branch', options.initialBranch ?? 'main');
    // Local identity and settings, written in one go (each git spawn costs tens of ms).
    await appendFile(
      join(dir, '.git', 'config'),
      `[user]\n\tname = ${AUTHOR_NAME}\n\temail = ${AUTHOR_EMAIL}\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n`,
      'utf8',
    );
    if (options.files) await commit(options.message ?? 'initial', options.files);
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
  return repo;
}
