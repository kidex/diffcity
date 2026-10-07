// The fix queue (ADR-036): `<working tree>/.diffcity/fix-queue.json`, format
// version 1, which the /diffcity-review slash command (ADR-037) takes by
// renaming it to `.diffcity/fix-queue.taking.json`, applies, then deletes.
//
// The command's rename may land between the daemon's read and its write. So
// right before its rename the daemon checks the queue again (lstat: the same
// file, size and mtime as read); when it disappeared or changed, the temporary
// file is dropped and the read-modify-write runs again, at most
// FIX_QUEUE_ATTEMPTS times, then `fix-queue-busy`. A queue that did not exist
// is created with link + unlink instead of rename, so a queue that appeared
// meanwhile is never overwritten (EEXIST, and another attempt). This way an
// item the command already took is never written back.
//
// The daemon writes only that file, only inside the change's working tree:
// `.diffcity` and the file are checked with lstat and refused when they are a
// symbolic link or not a directory / regular file; the directory is created
// (mode 0755) only when it is absent; the file is read without following a
// link and written through a temporary file in the same directory and a
// rename. At most FIX_QUEUE_MAX_ITEMS items and FIX_QUEUE_MAX_BYTES bytes.
// Synchronous on purpose: one append runs to its end before another starts.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Report } from '../report/types.js';

export const FIX_QUEUE_VERSION = 1;
export const FIX_QUEUE_MAX_ITEMS = 200;
export const FIX_QUEUE_MAX_BYTES = 1024 * 1024;
/** The markdown of a `review-summary` item is capped by its writer (ADR-029) at this many bytes. */
export const FIX_QUEUE_SUMMARY_MAX_BYTES = 64 * 1024;
export const FIX_QUEUE_DIR = '.diffcity';
export const FIX_QUEUE_FILE = 'fix-queue.json';
/** Read-modify-write rounds before an append gives up with `fix-queue-busy`. */
export const FIX_QUEUE_ATTEMPTS = 3;

/** A finding to fix. */
export interface FindingQueueItem {
  key: string;
  file: string;
  line: number;
  /** The name of the symbol the finding is anchored to; absent at file level. */
  symbol?: string;
  severity: Finding['severity'];
  title: string;
  message: string;
  fix?: string;
  queuedAt: string;
}

/** The review summary sent as one item (ADR-029): the markdown in `message`. */
export interface SummaryQueueItem {
  kind: 'review-summary';
  key: string;
  message: string;
  queuedAt: string;
}

export type FixQueueItem = FindingQueueItem | SummaryQueueItem;

export interface FixQueue {
  version: typeof FIX_QUEUE_VERSION;
  items: FixQueueItem[];
}

export type FixQueueRefusal = 'no-working-tree' | 'fix-queue-unsafe' | 'fix-queue-full' | 'fix-queue-invalid' | 'fix-queue-busy';

export type FixQueueResult =
  /** `queued` is false when an item with the same key was already in the queue (nothing written). */
  | { ok: true; queued: boolean; count: number }
  | { ok: false; code: FixQueueRefusal; message: string };

/** The fix-queue item of a served finding: its current line, and the name of the symbol it is anchored to. */
export function fixQueueItem(report: Report, finding: Finding, queuedAt: string): FindingQueueItem {
  let symbol: string | undefined;
  if (finding.symbolId !== undefined) {
    for (const pkg of report.packages) {
      for (const file of pkg.files) {
        if (file.path !== finding.file) continue;
        symbol = file.symbols.find((candidate) => candidate.id === finding.symbolId)?.name;
      }
    }
  }
  return {
    key: finding.id,
    file: finding.file,
    line: finding.line,
    ...(symbol === undefined ? {} : { symbol }),
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    ...(finding.fix === undefined ? {} : { fix: finding.fix }),
    queuedAt,
  };
}

/**
 * The working tree a change's fix queue goes to (ADR-036): the one checked out
 * at the change's head. `worktreePath` is null only when no working tree is at
 * that head; the repo's own path would then hold another commit (a fix queued
 * for a branch would be applied to whatever is checked out), so there is none,
 * whatever the change kind (`no-working-tree`).
 */
export function fixQueueRoot(change: { worktreePath: string | null }): string | null {
  return change.worktreePath;
}

const refuse = (code: FixQueueRefusal, message: string): FixQueueResult => ({ ok: false, code, message });

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** The same file, unchanged since `before` was taken: identity, size and modification time. */
const unchanged = (before: Stats, now: Stats): boolean => sameFile(before, now) && before.size === now.size && before.mtimeMs === now.mtimeMs;

function isQueue(value: unknown): value is FixQueue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { version, items } = value as Record<string, unknown>;
  return version === FIX_QUEUE_VERSION && Array.isArray(items) && items.every((item) => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>)['key'] === 'string');
}

/** Reads the queue through a descriptor opened without following a link, checked to be the file lstat saw. */
function readQueue(path: string, seen: Stats): FixQueue | FixQueueResult {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} changed while it was read`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || !sameFile(stats, seen)) return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} changed while it was read`);
    if (stats.size > FIX_QUEUE_MAX_BYTES) return refuse('fix-queue-full', `the fix queue is over ${String(FIX_QUEUE_MAX_BYTES)} bytes`);
    const text = readFileSync(fd, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse('fix-queue-invalid', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} is not valid JSON`);
    }
    return isQueue(parsed) ? parsed : refuse('fix-queue-invalid', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} is not a version ${String(FIX_QUEUE_VERSION)} fix queue`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `item` to the fix queue of the working tree at `root` (null: the
 * change has none). Idempotent per key. Refusals: `no-working-tree` (no root,
 * or it is not a directory), `fix-queue-unsafe` (a link or a non-regular
 * entry), `fix-queue-full` (over 200 items or 1 MiB), `fix-queue-invalid` (an
 * existing file that is not a version 1 queue, left as it is), `fix-queue-busy`
 * (the queue kept changing under the write, FIX_QUEUE_ATTEMPTS times).
 */
export function appendToFixQueue(root: string | null, item: FixQueueItem): FixQueueResult {
  if (root === null) return refuse('no-working-tree', 'the change has no working tree to queue a fix in');
  try {
    if (!statSync(root).isDirectory()) return refuse('no-working-tree', 'the working tree of the change is not a directory');
  } catch {
    return refuse('no-working-tree', 'the working tree of the change does not exist');
  }

  const dir = join(root, FIX_QUEUE_DIR);
  let dirStats = lstatOrNull(dir);
  if (dirStats === null) {
    try {
      mkdirSync(dir, { mode: 0o755 });
      // The mode asked of mkdir is reduced by the umask; the ADR fixes it at 0755.
      // Set through a descriptor that refuses a link, so a swapped entry is never followed.
      const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        if (fstatSync(fd).isDirectory()) fchmodSync(fd, 0o755);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // Created meanwhile, or swapped for a link or a file: the lstat below decides.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ELOOP' && code !== 'ENOTDIR') throw error;
    }
    dirStats = lstatOrNull(dir);
  }
  if (dirStats === null || dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR} is not a plain directory (a symbolic link or a file)`);
  }

  const path = join(dir, FIX_QUEUE_FILE);
  for (let attempt = 0; attempt < FIX_QUEUE_ATTEMPTS; attempt++) {
    const result = appendOnce(dir, dirStats, path, item);
    if (result !== 'retry') return result;
  }
  return refuse('fix-queue-busy', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} kept changing while the fix was queued; try again`);
}

/** One read-modify-write of the queue; 'retry' when the queue changed before the write landed. */
function appendOnce(dir: string, dirStats: Stats, path: string, item: FixQueueItem): FixQueueResult | 'retry' {
  const fileStats = lstatOrNull(path);
  let queue: FixQueue = { version: FIX_QUEUE_VERSION, items: [] };
  if (fileStats !== null) {
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR}/${FIX_QUEUE_FILE} is not a regular file (a symbolic link or a directory)`);
    }
    const read = readQueue(path, fileStats);
    if ('ok' in read) return read;
    queue = read;
  }

  if (queue.items.some((existing) => existing.key === item.key)) return { ok: true, queued: false, count: queue.items.length };
  if (queue.items.length >= FIX_QUEUE_MAX_ITEMS) return refuse('fix-queue-full', `the fix queue already holds ${String(FIX_QUEUE_MAX_ITEMS)} items`);
  const next: FixQueue = { version: FIX_QUEUE_VERSION, items: [...queue.items, item] };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > FIX_QUEUE_MAX_BYTES) return refuse('fix-queue-full', `the fix queue would be over ${String(FIX_QUEUE_MAX_BYTES)} bytes`);

  const temp = join(dir, `.${FIX_QUEUE_FILE}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  // `wx` is O_CREAT | O_EXCL: it never follows or reuses an existing entry.
  writeFileSync(temp, text, { flag: 'wx', mode: 0o644 });
  try {
    // The directory must still be the one checked: it was not swapped for a link while writing.
    const now = lstatOrNull(dir);
    if (now === null || now.isSymbolicLink() || !sameFile(now, dirStats)) {
      return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR} changed while the fix queue was written`);
    }
    if (fileStats === null) {
      // No queue was read: create it only if none appeared meanwhile (link fails with EEXIST).
      try {
        linkSync(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'retry';
        throw error;
      }
    } else {
      // The queue read must still be there, unchanged: /diffcity-review may have taken it meanwhile.
      const current = lstatOrNull(path);
      if (current === null || !unchanged(fileStats, current)) return 'retry';
      renameSync(temp, path);
    }
    return { ok: true, queued: true, count: next.items.length };
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Renamed into place, which is the normal case; after a link the temporary name is removed here.
    }
  }
}
