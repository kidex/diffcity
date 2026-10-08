// Changed files, file contents and the head file list for a resolved change.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { ResolvedChange } from './change.js';
import { GitError, git, gitRaw, gitStream, splitNul } from './exec.js';
import { isOwnFile } from './own-files.js';

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

/**
 * Flags that keep git's diff output stable regardless of user config, and keep
 * git from running commands the repo names (DC-37): no external diff, no
 * textconv, and no look inside submodules. Without --ignore-submodules=dirty a
 * working tree diff runs `git status` in each submodule, which applies that
 * submodule's own filters; a moved submodule pointer is still seen.
 */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-relative',
  '--no-textconv',
  '--ignore-submodules=dirty',
  '-M',
  '--raw',
  '--numstat',
  '-z',
];

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

/** Git's binary heuristic over file bytes: a NUL byte in the first 8000 bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Binary flag of an untracked entry. Only regular files are opened (git's own
 * heuristic: a NUL byte in the first 8000 bytes). A symlink is stored by git as
 * its target text, so it is never binary; anything else (FIFO, socket, device)
 * is never opened. A file that cannot be read counts as not binary.
 */
async function isBinaryOnDisk(absPath: string): Promise<boolean> {
  try {
    const stats = await lstat(absPath);
    if (!stats.isFile()) return false;
    const handle = await open(absPath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      return looksBinary(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Non-ignored untracked files, relative to the root. Nested repositories
 * (listed by git as `dir/`) are not files of this change and are left out, and
 * so are diffcity's own files (own-files.ts).
 */
async function untrackedFiles(root: string): Promise<string[]> {
  const entries = splitNul(await git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']));
  return entries.filter((path) => !path.endsWith('/') && !isOwnFile(path));
}

/**
 * Leaves diffcity's own files out of a diff (own-files.ts): an own file is
 * dropped; a rename from an own file is the plain add of its new path.
 */
function withoutOwnFiles(files: ChangedFile[]): ChangedFile[] {
  const kept: ChangedFile[] = [];
  for (const file of files) {
    if (isOwnFile(file.path)) continue;
    if (file.oldPath !== null && file.oldPath !== file.path && isOwnFile(file.oldPath)) kept.push({ ...file, oldPath: null, type: 'add' });
    else kept.push(file);
  }
  return kept;
}

/**
 * Diff of the working tree against the merge-base, untracked files included.
 *
 * Untracked files are made visible to rename detection by marking them
 * intent-to-add (`git add -N`) in a throwaway copy of the index, so a plain
 * `mv` pairs up as a rename. The repo's own index and object store are never
 * written: the index copy and any object git writes live in os.tmpdir().
 */
async function worktreeChanges(root: string, mergeBase: string): Promise<ChangedFile[]> {
  const addable: string[] = [];
  const others: string[] = [];
  for (const path of await untrackedFiles(root)) {
    try {
      const stats = await lstat(join(root, path));
      (stats.isFile() || stats.isSymbolicLink() ? addable : others).push(path);
    } catch {
      // Vanished between listing and lstat: not part of the change any more.
    }
  }

  const diffArgs = ['diff', ...DIFF_FLAGS, mergeBase, '--'];
  if (addable.length === 0) return withOthers(root, parseDiffOutput(await git(root, diffArgs)), others);
  return withIntentToAddIndex(root, addable, async (env) =>
    // Without an index copy (see withIntentToAddIndex) the untracked files are plain adds.
    withOthers(root, parseDiffOutput(await git(root, diffArgs, env === undefined ? {} : { env })), env === undefined ? [...addable, ...others] : others),
  );
}

/**
 * Runs `run` with the environment of a throwaway copy of the index in which
 * `untracked` (files and symlinks, relative to the root) are marked
 * intent-to-add, so git diffs them as adds and pairs them up for rename
 * detection. The repo's own index and object store are never written: the
 * copy and any object git writes live in os.tmpdir(), removed afterwards.
 * `run` gets `undefined` when no copy could be made (no index to copy, or an
 * untracked file vanished before `add`): it then diffs without it.
 */
export async function withIntentToAddIndex<T>(
  root: string,
  untracked: readonly string[],
  run: (env: Record<string, string> | undefined) => Promise<T>,
): Promise<T> {
  const gitPath = async (name: string): Promise<string> =>
    (await git(root, ['rev-parse', '--path-format=absolute', '--git-path', name])).trim();
  const indexFile = await gitPath('index');
  const objectsDir = await gitPath('objects');
  const tempDir = await mkdtemp(join(tmpdir(), 'diffcity-index-'));
  try {
    const tempIndex = join(tempDir, 'index');
    try {
      await copyFile(indexFile, tempIndex);
      // Keep git's racy-entry check honest: entries modified at or after the
      // index's mtime are re-checked by content. A copy gets a fresh mtime,
      // which would make same-size edits look clean, so back-date it instead.
      const { atimeMs, mtimeMs } = await stat(indexFile);
      await utimes(tempIndex, atimeMs / 1000, (mtimeMs - 1000) / 1000);
    } catch {
      // No index to copy (unusual once HEAD exists).
      return await run(undefined);
    }
    const tempObjects = join(tempDir, 'objects');
    await mkdir(tempObjects);
    const env = {
      GIT_INDEX_FILE: tempIndex,
      // Anything git decides to write (the empty blob for intent-to-add) lands in
      // the temp dir; the repo's own objects are still readable as an alternate.
      GIT_OBJECT_DIRECTORY: tempObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsDir,
      GIT_LITERAL_PATHSPECS: '1',
    };
    try {
      await git(
        root,
        ['-c', 'core.splitIndex=false', 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        { env, input: untracked.map((path) => `${path}\0`).join('') },
      );
    } catch {
      // Typically an untracked file vanished after ls-files (a bundler's temp
      // file): pathspec did not match. Plain diff for this round; only rename
      // pairing with untracked files is lost.
      return await run(undefined);
    }
    return await run(env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Adds untracked entries that git did not diff as `add`. Entries that no longer
 * exist on disk are dropped: they are not part of the change any more.
 */
async function withOthers(root: string, files: ChangedFile[], others: string[]): Promise<ChangedFile[]> {
  const known = new Set(files.map((file) => file.path));
  for (const path of others) {
    if (known.has(path)) continue;
    const absPath = join(root, path);
    try {
      await lstat(absPath);
    } catch {
      continue;
    }
    files.push({ path, oldPath: null, type: 'add', binary: await isBinaryOnDisk(absPath) });
  }
  return files;
}

/**
 * Files that differ between before (merge-base) and after, sorted by path.
 * Renames are detected with `-M` (50% similarity), including between a deleted
 * tracked file and an untracked one. In the working tree case, non-ignored
 * untracked files are reported as `add`. diffcity's own files at the root
 * (`.diffcity/findings.json`, the fix queue directories; own-files.ts) are
 * never listed, committed or not.
 */
export async function changedFiles(change: ResolvedChange): Promise<ChangedFile[]> {
  const files = change.worktree
    ? await worktreeChanges(change.root, change.mergeBase)
    : parseDiffOutput(await git(change.root, ['diff', ...DIFF_FLAGS, change.mergeBase, change.headCommit, '--']));
  return withoutOwnFiles(files).sort(byPath);
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

/**
 * Throws when `commit`'s tree lists `path` as a blob: the path exists but its
 * object is not in the local store (a partial clone, which diffcity never
 * fetches from). Reporting such a file as absent would silently be wrong.
 */
async function assertBlobAbsent(root: string, commit: string, path: string): Promise<void> {
  const listing = await gitRaw(root, ['ls-tree', '-z', '--full-tree', commit, '--', path], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  // The commit resolved, so its tree should list: failing means the tree (or a
  // subtree) is missing too, as in a treeless clone. Absence cannot be proven.
  if (listing.exitCode !== 0) {
    throw new GitError('git-failed', `tree of ${commit} is not available locally (partial clone?): ${listing.stderr.trim()}`);
  }
  for (const entry of splitNul(listing.stdout.toString('utf8'))) {
    const tab = entry.indexOf('\t');
    const [, type] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && entry.slice(tab + 1) === path) {
      throw new GitError('git-failed', `object of ${path} at ${commit} is not available locally (partial clone?)`);
    }
  }
}

async function readBlob(root: string, commit: string, path: string): Promise<Buffer | null> {
  const repoPath = checkRepoPath(path);
  const result = await gitRaw(root, ['cat-file', 'blob', `${commit}:${repoPath}`]);
  if (result.exitCode === 0) return result.stdout;
  await assertBlobAbsent(root, commit, repoPath);
  return null;
}

/** Content of `path` (repo-relative) in the before state, or null when it does not exist there. */
export async function readBefore(change: ResolvedChange, path: string): Promise<string | null> {
  return (await readBeforeBytes(change, path))?.toString('utf8') ?? null;
}

/** Raw bytes of `path` (repo-relative) in the before state, or null when it does not exist there. */
export async function readBeforeBytes(change: ResolvedChange, path: string): Promise<Buffer | null> {
  return readBlob(change.root, change.mergeBase, path);
}

/** Content of `path` (repo-relative) in the after state, or null when it does not exist there. */
export async function readAfter(change: ResolvedChange, path: string): Promise<string | null> {
  return (await readAfterBytes(change, path))?.toString('utf8') ?? null;
}

/**
 * Raw bytes of `path` (repo-relative) in the after state, or null when it does not exist there.
 * For the working tree this is the file on disk; a symlink reads as its target text, as git stores it.
 */
export async function readAfterBytes(change: ResolvedChange, path: string): Promise<Buffer | null> {
  if (!change.worktree) return readBlob(change.root, change.headCommit, path);
  const absPath = await confinedWorktreePath(change.root, path);
  if (absPath === null) return null;
  try {
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) return await readlink(absPath, { encoding: 'buffer' });
    if (!stats.isFile()) return null;
    return await readFile(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function blobSize(root: string, commit: string, path: string): Promise<number | null> {
  const repoPath = checkRepoPath(path);
  const result = await gitRaw(root, ['cat-file', '-s', `${commit}:${repoPath}`]);
  const size = Number(result.stdout.toString('utf8').trim());
  if (result.exitCode === 0 && Number.isSafeInteger(size) && size >= 0) return size;
  await assertBlobAbsent(root, commit, repoPath);
  return null;
}

/** Size in bytes of `path` in the before state, from the object header (nothing is read), or null when it does not exist there. */
export async function sizeBefore(change: ResolvedChange, path: string): Promise<number | null> {
  return blobSize(change.root, change.mergeBase, path);
}

/**
 * Size in bytes of `path` in the after state, or null when it does not exist
 * there. A commit answers from the object header (`git cat-file -s`); the
 * working tree from lstat. Nothing is read. Same file set as readAfterBytes.
 */
export async function sizeAfter(change: ResolvedChange, path: string): Promise<number | null> {
  if (!change.worktree) return blobSize(change.root, change.headCommit, path);
  const absPath = await confinedWorktreePath(change.root, path);
  if (absPath === null) return null;
  try {
    const stats = await lstat(absPath);
    return stats.isSymbolicLink() || stats.isFile() ? stats.size : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** sizeAfter for many paths, in input order; a commit uses one `git cat-file --batch-check` call. */
export async function sizeAfterBatch(change: ResolvedChange, paths: readonly string[]): Promise<(number | null)[]> {
  const results = new Array<number | null>(paths.length).fill(null);
  const batched: { index: number; path: string }[] = [];
  if (change.worktree) {
    for (let i = 0; i < paths.length; i += WORKTREE_READ_CONCURRENCY) {
      await Promise.all(
        paths.slice(i, i + WORKTREE_READ_CONCURRENCY).map(async (path, j) => {
          results[i + j] = await sizeAfter(change, path);
        }),
      );
    }
    return results;
  }
  await Promise.all(
    paths.map(async (path, index) => {
      if (/[\r\n]/.test(path)) results[index] = await sizeAfter(change, path);
      else batched.push({ index, path: checkRepoPath(path) });
    }),
  );
  if (batched.length === 0) return results;
  const input = batched.map(({ path }) => `${change.headCommit}:${path}\n`).join('');
  const result = await gitRaw(change.root, ['cat-file', '--batch-check'], { input });
  if (result.exitCode !== 0) throw new GitError('git-failed', `git cat-file --batch-check failed: ${result.stderr.trim()}`);
  const lines = result.stdout.toString('utf8').split('\n');
  await Promise.all(
    batched.map(async ({ index, path }, i) => {
      const line = lines[i] ?? '';
      const [, type, sizeText = ''] = line.split(' ');
      const size = Number.parseInt(sizeText, 10);
      if (type === 'blob' && Number.isSafeInteger(size)) results[index] = size;
      // Missing: an absent path or a blob a partial clone lacks; blobSize tells them apart.
      else if (line.endsWith(' missing')) results[index] = await sizeAfter(change, path);
    }),
  );
  return results;
}

async function hashBlob(root: string, commit: string, path: string): Promise<string | null> {
  const repoPath = checkRepoPath(path);
  const hash = createHash('sha256');
  const result = await gitStream(root, ['cat-file', 'blob', `${commit}:${repoPath}`], (chunk) => {
    hash.update(chunk);
  });
  if (result.exitCode === 0) return hash.digest('hex');
  await assertBlobAbsent(root, commit, repoPath);
  return null;
}

/** sha256 hex of `path` in the before state, streamed (never buffered), or null when it does not exist there. */
export async function hashBefore(change: ResolvedChange, path: string): Promise<string | null> {
  return hashBlob(change.root, change.mergeBase, path);
}

/**
 * sha256 hex of `path` in the after state, streamed (never buffered), or null
 * when it does not exist there. Same bytes as readAfterBytes: a symlink hashes
 * its target text.
 */
export async function hashAfter(change: ResolvedChange, path: string): Promise<string | null> {
  if (!change.worktree) return hashBlob(change.root, change.headCommit, path);
  const absPath = await confinedWorktreePath(change.root, path);
  if (absPath === null) return null;
  try {
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) return createHash('sha256').update(await readlink(absPath, { encoding: 'buffer' })).digest('hex');
    if (!stats.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Lines of a text: its line feeds, plus one for a last line without one. Zero for empty content. */
export function countLines(bytes: Uint8Array): number {
  let count = 0;
  let at = bytes.indexOf(0x0a);
  while (at !== -1) {
    count += 1;
    at = bytes.indexOf(0x0a, at + 1);
  }
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? count + 1 : count;
}

/**
 * Size and line count of a version, gathered while it streams. The first
 * BINARY_SNIFF_BYTES decide binary content (git's heuristic) before any line
 * is counted: `add` answers `binary` as soon as they show a NUL byte, and the
 * caller stops reading, so a large binary is never streamed in full.
 */
export class LineMeasure {
  bytes = 0;
  private feeds = 0;
  private last = -1;
  private head: Buffer[] = [];
  private headSize = 0;
  /** null while the head is still being read. */
  private binary: boolean | null = null;

  /** Takes the next chunk; `binary` means stop: the content is binary and lines() is null. */
  add(chunk: Buffer): 'binary' | 'text' {
    this.bytes += chunk.length;
    if (this.binary === null) {
      this.head.push(chunk);
      this.headSize += chunk.length;
      if (this.headSize < BINARY_SNIFF_BYTES) return 'text';
      // decide() counts the head's lines when it is text.
      return this.decide() ? 'binary' : 'text';
    }
    this.count(chunk);
    return 'text';
  }

  /** The line count; null for binary content, as no line count means anything there. */
  lines(): number | null {
    if (this.binary ?? this.decide()) return null;
    return this.bytes > 0 && this.last !== 0x0a ? this.feeds + 1 : this.feeds;
  }

  /** Decides binary from the head read so far; true when binary. */
  private decide(): boolean {
    const head = Buffer.concat(this.head);
    this.head = [];
    const binary = looksBinary(head);
    this.binary = binary;
    if (!binary) this.count(head);
    return binary;
  }

  private count(chunk: Buffer): void {
    let at = chunk.indexOf(0x0a);
    while (at !== -1) {
      this.feeds += 1;
      at = chunk.indexOf(0x0a, at + 1);
    }
    if (chunk.length > 0) this.last = chunk[chunk.length - 1] ?? -1;
  }
}

/** Thrown from a stream callback to stop reading a binary blob. */
class BinaryStop extends Error {}

/**
 * Size in bytes and line count of `path` in the after state, streamed (never
 * buffered), or null when it does not exist there. Lines are null for binary
 * content, whose reading stops after its first BINARY_SNIFF_BYTES: the size
 * then comes from the object header or lstat. Same bytes as readAfterBytes: a
 * symlink measures its target text.
 */
export async function measureAfter(change: ResolvedChange, path: string): Promise<{ bytes: number; lines: number | null } | null> {
  const measure = new LineMeasure();
  if (!change.worktree) {
    const repoPath = checkRepoPath(path);
    let result;
    try {
      result = await gitStream(change.root, ['cat-file', 'blob', `${change.headCommit}:${repoPath}`], (chunk) => {
        if (measure.add(chunk) === 'binary') throw new BinaryStop();
      });
    } catch (error) {
      if (!(error instanceof BinaryStop)) throw error;
      const bytes = await blobSize(change.root, change.headCommit, path);
      return bytes === null ? null : { bytes, lines: null };
    }
    if (result.exitCode !== 0) {
      await assertBlobAbsent(change.root, change.headCommit, repoPath);
      return null;
    }
    return { bytes: measure.bytes, lines: measure.lines() };
  }
  const absPath = await confinedWorktreePath(change.root, path);
  if (absPath === null) return null;
  try {
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) measure.add(await readlink(absPath, { encoding: 'buffer' }));
    else if (!stats.isFile()) return null;
    else {
      for await (const chunk of createReadStream(absPath)) {
        // Leaving the loop closes the stream.
        if (measure.add(chunk as Buffer) === 'binary') return { bytes: stats.size, lines: null };
      }
    }
    return { bytes: measure.bytes, lines: measure.lines() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Working tree files read at the same time by readAfterBatch. */
const WORKTREE_READ_CONCURRENCY = 8;

/**
 * Parses `git cat-file --batch` output for `count` requests, in request order.
 * Each answer is `<sha> <type> <size>\n<content>\n`, or `<name> missing\n` /
 * `<name> ambiguous\n`. Only blobs are returned; anything else is null.
 */
function parseCatFileBatch(output: Buffer, count: number): (Buffer | null)[] {
  const results: (Buffer | null)[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const eol = output.indexOf(0x0a, offset);
    if (eol < 0) throw new GitError('git-failed', 'unexpected end of git cat-file --batch output');
    const header = output.toString('utf8', offset, eol);
    offset = eol + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      results.push(null);
      continue;
    }
    const [, type, sizeText = ''] = header.split(' ');
    const size = Number.parseInt(sizeText, 10);
    if (!Number.isInteger(size) || size < 0 || offset + size > output.length) {
      throw new GitError('git-failed', `unexpected git cat-file --batch header: ${header}`);
    }
    results.push(type === 'blob' ? output.subarray(offset, offset + size) : null);
    offset += size + 1;
  }
  return results;
}

/**
 * readAfterBytes for many paths, in input order. For a commit, one
 * `git cat-file --batch` call reads every blob (paths containing a line break,
 * which the batch protocol cannot carry, are read one by one). For the working
 * tree, files are read from disk a few at a time. Callers bound `paths` so the
 * answer fits comfortably in memory.
 */
export async function readAfterBatch(change: ResolvedChange, paths: readonly string[]): Promise<(Buffer | null)[]> {
  if (change.worktree) {
    const results: (Buffer | null)[] = [];
    for (let i = 0; i < paths.length; i += WORKTREE_READ_CONCURRENCY) {
      const group = paths.slice(i, i + WORKTREE_READ_CONCURRENCY);
      results.push(...(await Promise.all(group.map((path) => readAfterBytes(change, path)))));
    }
    return results;
  }

  const batched: { index: number; path: string }[] = [];
  const results = new Array<Buffer | null>(paths.length).fill(null);
  await Promise.all(
    paths.map(async (path, index) => {
      if (/[\r\n]/.test(path)) results[index] = await readBlob(change.root, change.headCommit, path);
      else batched.push({ index, path: checkRepoPath(path) });
    }),
  );
  if (batched.length === 0) return results;

  const input = batched.map(({ path }) => `${change.headCommit}:${path}\n`).join('');
  const result = await gitRaw(change.root, ['cat-file', '--batch'], { input });
  if (result.exitCode !== 0) throw new GitError('git-failed', `git cat-file --batch failed: ${result.stderr.trim()}`);
  const answers = parseCatFileBatch(result.stdout, batched.length);
  await Promise.all(
    batched.map(async ({ index, path }, i) => {
      const bytes = answers[i] ?? null;
      // A missing answer is either an absent path or a blob a partial clone lacks; readBlob tells them apart.
      results[index] = bytes ?? (await readBlob(change.root, change.headCommit, path));
    }),
  );
  return results;
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
