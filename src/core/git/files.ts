// Changed files, file contents and the head file list for a resolved change.

import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ResolvedChange } from './change.js';
import { GitError, git, gitRaw, splitNul } from './exec.js';

export type ChangeType = 'add' | 'del' | 'mod' | 'rename';

export interface ChangedFile {
  /** Path relative to the repo root, `/`-separated. For `del`, the deleted path. For `rename`, the new path. */
  path: string;
  /** Path in the before state; `null` for `add`. Equal to `path` except for `rename`. */
  oldPath: string | null;
  type: ChangeType;
  binary: boolean;
}

const GITLINK_MODE = '160000';

/** Flags that keep git's diff output stable regardless of user config. */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-relative', '--no-textconv', '-M', '--raw', '--numstat', '-z'];

/** Git's own binary heuristic: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

function byPath(a: ChangedFile, b: ChangedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Parses `git diff --raw --numstat -z` output: all raw records, then all numstat records.
 * Raw: `:<srcMode> <dstMode> <srcSha> <dstSha> <status>\0<path>\0` (two paths for R/C).
 * Numstat: `<added>\t<deleted>\t<path>\0`, or `<added>\t<deleted>\t\0<old>\0<new>\0` for renames.
 */
export function parseDiffOutput(output: string): ChangedFile[] {
  const tokens = splitNul(output);
  const files: ChangedFile[] = [];
  const binaryPaths = new Set<string>();
  let i = 0;

  const next = (): string => {
    const token = tokens[i++];
    if (token === undefined) throw new GitError('git-failed', 'unexpected end of git diff output');
    return token;
  };

  while (i < tokens.length) {
    const head = next();
    if (head.startsWith(':')) {
      const [srcMode, dstMode, , , status = ''] = head.slice(1).split(' ');
      const letter = status.charAt(0);
      const first = next();
      const second = letter === 'R' || letter === 'C' ? next() : undefined;
      if (srcMode === GITLINK_MODE || dstMode === GITLINK_MODE) continue;
      if (letter === 'A') files.push({ path: first, oldPath: null, type: 'add', binary: false });
      else if (letter === 'D') files.push({ path: first, oldPath: first, type: 'del', binary: false });
      else if (letter === 'R' && second !== undefined) {
        files.push({ path: second, oldPath: first, type: 'rename', binary: false });
      } else if (letter === 'C' && second !== undefined) {
        // Copies are not requested (-M only); treat defensively as an add.
        files.push({ path: second, oldPath: null, type: 'add', binary: false });
      } else files.push({ path: first, oldPath: first, type: 'mod', binary: false });
    } else {
      // Split on the first two tabs only: the path itself may contain tabs.
      const firstTab = head.indexOf('\t');
      const secondTab = head.indexOf('\t', firstTab + 1);
      const added = head.slice(0, firstTab);
      const deleted = head.slice(firstTab + 1, secondTab);
      const path = head.slice(secondTab + 1);
      const newPath = path === '' ? (next(), next()) : path;
      if (added === '-' && deleted === '-') binaryPaths.add(newPath);
    }
  }

  for (const file of files) file.binary = binaryPaths.has(file.path);
  return files;
}

async function isBinaryOnDisk(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Non-ignored untracked files, relative to the root. */
async function untrackedFiles(root: string): Promise<string[]> {
  return splitNul(await git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']));
}

/**
 * Files that differ between before (merge-base) and after, sorted by path.
 * Renames are detected with `-M` (50% similarity). In the working tree case,
 * non-ignored untracked files are reported as `add`.
 */
export async function changedFiles(change: ResolvedChange): Promise<ChangedFile[]> {
  const { root } = change;
  const range = change.worktree ? [change.mergeBase] : [change.mergeBase, change.headCommit];
  const files = parseDiffOutput(await git(root, ['diff', ...DIFF_FLAGS, ...range, '--']));

  if (change.worktree) {
    const known = new Set(files.map((file) => file.path));
    for (const path of await untrackedFiles(root)) {
      if (known.has(path)) continue;
      files.push({ path, oldPath: null, type: 'add', binary: await isBinaryOnDisk(join(root, path)) });
    }
  }

  return files.sort(byPath);
}

function badPath(path: string, reason: string): GitError {
  return new GitError('bad-path', `${reason}: ${path}`);
}

function hasGitSegment(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment.toLowerCase() === '.git');
}

/** Validates a repo-relative path: no absolute path, no `..` escape, no `.git` segment. */
function checkRepoPath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    path === '' ||
    path.includes('\\') ||
    posix.isAbsolute(path) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw badPath(path, 'path must be relative to the repo root');
  }
  if (hasGitSegment(normalized)) throw badPath(path, 'path must not point into .git');
  return normalized;
}

/**
 * Absolute on-disk location of a repo-relative path, with every directory
 * symlink resolved, or null when its parent directory does not exist. The last
 * component is not followed: a symlink is read as a link, like git stores it.
 * Throws when the resolved parent lies outside the repo or inside `.git`.
 */
async function confinedWorktreePath(root: string, path: string): Promise<string | null> {
  const relPath = checkRepoPath(path);
  const realRoot = await realpath(root);
  let realParent: string;
  try {
    realParent = await realpath(join(realRoot, dirname(relPath)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  const inside = relative(realRoot, realParent);
  if (inside.startsWith('..') || isAbsolute(inside)) throw badPath(path, 'path resolves outside the repo');
  if (hasGitSegment(inside.split(sep).join('/'))) throw badPath(path, 'path must not point into .git');
  return join(realParent, basename(relPath));
}

async function readBlob(root: string, commit: string, path: string): Promise<string | null> {
  const result = await gitRaw(root, ['cat-file', 'blob', `${commit}:${checkRepoPath(path)}`]);
  if (result.exitCode !== 0) return null;
  return result.stdout.toString('utf8');
}

/** Content of `path` (repo-relative) in the before state, or null when it does not exist there. */
export function readBefore(change: ResolvedChange, path: string): Promise<string | null> {
  return readBlob(change.root, change.mergeBase, path);
}

/**
 * Content of `path` (repo-relative) in the after state, or null when it does not exist there.
 * For the working tree this is the file on disk; a symlink reads as its target text, as git stores it.
 */
export async function readAfter(change: ResolvedChange, path: string): Promise<string | null> {
  if (!change.worktree) return readBlob(change.root, change.headCommit, path);
  const absPath = await confinedWorktreePath(change.root, path);
  if (absPath === null) return null;
  try {
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) return await readlink(absPath, 'utf8');
    if (!stats.isFile()) return null;
    return await readFile(absPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Every file in the after state, sorted, repo-relative. For a commit: the blobs of its tree.
 * For the working tree: tracked files still on disk plus non-ignored untracked files.
 * Submodules are not files and are left out.
 */
export async function listHeadFiles(change: ResolvedChange): Promise<string[]> {
  const { root } = change;
  const paths = new Set<string>();

  if (!change.worktree) {
    // <mode> SP <type> SP <sha> TAB <path>
    for (const entry of splitNul(await git(root, ['ls-tree', '-r', '-z', '--full-tree', change.headCommit]))) {
      const tab = entry.indexOf('\t');
      const [, type] = entry.slice(0, tab).split(' ');
      if (type === 'blob') paths.add(entry.slice(tab + 1));
    }
  } else {
    // <mode> SP <sha> SP <stage> TAB <path>
    for (const entry of splitNul(await git(root, ['ls-files', '-z', '--stage', '--full-name']))) {
      const tab = entry.indexOf('\t');
      if (!entry.startsWith(GITLINK_MODE)) paths.add(entry.slice(tab + 1));
    }
    for (const path of splitNul(await git(root, ['ls-files', '-z', '--deleted', '--full-name']))) paths.delete(path);
    for (const path of await untrackedFiles(root)) paths.add(path);
  }

  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
