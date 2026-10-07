// The fix queue (ADR-036, redesigned by DC-112): a directory
// `<working tree>/.diffcity/fix-queue/` with one file per item, `<id>.json`,
// holding the version 1 item object itself (no envelope). `<id>` is the first
// 32 hex digits of the SHA-256 of the item key: file-name safe, and the same
// key always names the same file, so a key already queued is not queued again.
//
// The /diffcity-review slash command (ADR-037) takes the whole queue at once
// by renaming the directory to `.diffcity/fix-queue.taking/`, reads every
// `*.json` in it and removes it. The daemon never rewrites an existing item:
// it writes a temporary file `.diffcity/.fix-queue.<id>.<pid>.<12 hex>.tmp`
// once, next to the queue directory, and renames it to `fix-queue/<id>.json`.
// Both renames are atomic, so the item lands either in the directory before it
// is taken (and is taken with it) or, when the take came first, the rename
// fails with ENOENT, the temporary file is still in `.diffcity`, and the
// daemon creates a fresh queue directory and renames again. No item is lost or
// applied twice, and POSIX needs no compare-and-swap for it. The temporary
// file stays outside the queue directory so a take never carries it away: a
// retry is only `mkdir` and `rename`. After FIX_QUEUE_ATTEMPTS takes in a row
// the append gives up with `fix-queue-busy`.
//
// The daemon writes only inside the change's working tree: `.diffcity` and
// `.diffcity/fix-queue` are checked with lstat and refused when they are a
// symbolic link or not a directory; each is created (mode 0755) only when it
// is absent. At most FIX_QUEUE_MAX_ITEMS items and FIX_QUEUE_MAX_BYTES bytes,
// counted over the directory's item files before the write. Synchronous on
// purpose: one append runs to its end before another starts.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { Finding, Report } from '../report/types.js';

export const FIX_QUEUE_VERSION = 1;
export const FIX_QUEUE_MAX_ITEMS = 200;
export const FIX_QUEUE_MAX_BYTES = 1024 * 1024;
/** The markdown of a `review-summary` item is capped by its writer (ADR-029) at this many bytes. */
export const FIX_QUEUE_SUMMARY_MAX_BYTES = 64 * 1024;
/** The directory of diffcity's own files, at the working tree root. */
export const FIX_QUEUE_DIR = '.diffcity';
/** The queue directory inside FIX_QUEUE_DIR. */
export const FIX_QUEUE_NAME = 'fix-queue';
/** The name the slash command renames the queue directory to while it applies it. */
export const FIX_QUEUE_TAKING_NAME = 'fix-queue.taking';
/** Writes before an append gives up with `fix-queue-busy`, when the queue is taken under each one. */
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

export type FixQueueRefusal = 'no-working-tree' | 'fix-queue-unsafe' | 'fix-queue-full' | 'fix-queue-busy';

export type FixQueueResult =
  /** `queued` is false when an item with the same key is already in the queue (nothing written); `count` is the items in the queue. */
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

/** The file name of an item in the queue directory: 32 hex digits of the SHA-256 of its key, then `.json`. */
export function fixQueueItemName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;
}

const refuse = (code: FixQueueRefusal, message: string): FixQueueResult => ({ ok: false, code, message });

const QUEUE_LABEL = `${FIX_QUEUE_DIR}/${FIX_QUEUE_NAME}`;

/** An item file of the queue directory: `<32 hex>.json`; temporary files start with a dot. */
const ITEM_NAME = /^[0-9a-f]{32}\.json$/;

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Sets mode 0755 on a directory diffcity created (mkdir's mode is reduced by
 * the umask), through a descriptor that refuses a link. A directory taken or
 * swapped meanwhile is left alone.
 */
function fixMode(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return;
  }
  try {
    if (fstatSync(fd).isDirectory()) fchmodSync(fd, 0o755);
  } finally {
    closeSync(fd);
  }
}

/** `.diffcity`, created with mode 0755 when absent; a symbolic link or anything but a directory is refused. */
function ensureOwnDir(path: string): Stats | FixQueueResult {
  let stats = lstatOrNull(path);
  if (stats === null) {
    try {
      mkdirSync(path, { mode: 0o755 });
      fixMode(path);
    } catch (error) {
      // Created meanwhile, or swapped for a link or a file: the lstat below decides.
      const code = errorCode(error);
      if (code !== 'EEXIST' && code !== 'ELOOP' && code !== 'ENOTDIR') throw error;
    }
    stats = lstatOrNull(path);
  }
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    return refuse('fix-queue-unsafe', `${FIX_QUEUE_DIR} is not a plain directory (a symbolic link or a file)`);
  }
  return stats;
}

const unsafeQueueDir = (): FixQueueResult => refuse('fix-queue-unsafe', `${QUEUE_LABEL} is not a plain directory (a symbolic link or a file)`);

/** The item files of the queue directory and their total size; none when the directory was taken while it was listed. */
function queueContents(dir: string): { count: number; bytes: number } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { count: 0, bytes: 0 };
    throw error;
  }
  let count = 0;
  let bytes = 0;
  for (const name of names) {
    if (!ITEM_NAME.test(name)) continue;
    const stats = lstatOrNull(join(dir, name));
    if (stats === null || !stats.isFile()) continue;
    count++;
    bytes += stats.size;
  }
  return { count, bytes };
}

/** Renames `temp` to `path`: 'ok', or 'gone' when the queue directory (or the temporary file) is not there. */
function renameInto(temp: string, path: string): 'ok' | 'gone' | FixQueueResult {
  try {
    renameSync(temp, path);
    return 'ok';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') return 'gone';
    if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'ELOOP') return unsafeQueueDir();
    throw error;
  }
}

/**
 * Appends `item` to the fix queue of the working tree at `root` (null: the
 * change has none). Idempotent per key while the item is queued. Refusals:
 * `no-working-tree` (no root, or it is not a directory), `fix-queue-unsafe`
 * (`.diffcity`, the queue directory or the item's file is a link or not what
 * it should be), `fix-queue-full` (over 200 items or 1 MiB), `fix-queue-busy`
 * (the queue was taken under each of FIX_QUEUE_ATTEMPTS renames).
 *
 * The temporary file is written once, in `.diffcity` next to the queue
 * directory, so a take never carries it away: each attempt is only the rename
 * into `fix-queue/` (and its `mkdir` when the directory is gone), which keeps
 * the window a take can hit as small as two system calls.
 */
export function appendToFixQueue(root: string | null, item: FixQueueItem): FixQueueResult {
  if (root === null) return refuse('no-working-tree', 'the change has no working tree to queue a fix in');
  try {
    if (!statSync(root).isDirectory()) return refuse('no-working-tree', 'the working tree of the change is not a directory');
  } catch {
    return refuse('no-working-tree', 'the working tree of the change does not exist');
  }

  const text = `${JSON.stringify(item, null, 2)}\n`;
  const size = Buffer.byteLength(text, 'utf8');
  if (size > FIX_QUEUE_MAX_BYTES) return refuse('fix-queue-full', `the fix would make the queue over ${String(FIX_QUEUE_MAX_BYTES)} bytes`);

  const own = join(root, FIX_QUEUE_DIR);
  const ownStats = ensureOwnDir(own);
  if ('ok' in ownStats) return ownStats;
  const dir = join(own, FIX_QUEUE_NAME);
  const name = fixQueueItemName(item.key);
  const path = join(dir, name);
  const temp = join(own, `.${FIX_QUEUE_NAME}.${name.slice(0, -'.json'.length)}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  let written = false;
  try {
    for (let attempt = 0; attempt < FIX_QUEUE_ATTEMPTS; attempt++) {
      let contents = { count: 0, bytes: 0 };
      const queueStats = lstatOrNull(dir);
      if (queueStats !== null) {
        if (queueStats.isSymbolicLink() || !queueStats.isDirectory()) return unsafeQueueDir();
        const existing = lstatOrNull(path);
        if (existing !== null) {
          if (existing.isSymbolicLink() || !existing.isFile()) return refuse('fix-queue-unsafe', `${QUEUE_LABEL}/${name} is not a regular file (a symbolic link or a directory)`);
          return { ok: true, queued: false, count: queueContents(dir).count };
        }
        contents = queueContents(dir);
        if (contents.count >= FIX_QUEUE_MAX_ITEMS) return refuse('fix-queue-full', `the fix queue already holds ${String(FIX_QUEUE_MAX_ITEMS)} items`);
        if (contents.bytes + size > FIX_QUEUE_MAX_BYTES) return refuse('fix-queue-full', `the fix queue would be over ${String(FIX_QUEUE_MAX_BYTES)} bytes`);
      }
      if (!written || lstatOrNull(temp) === null) {
        // `wx` is O_CREAT | O_EXCL: it never follows or reuses an existing entry.
        writeFileSync(temp, text, { flag: 'wx', mode: 0o644 });
        written = true;
      }

      // The queue directory must still be the one checked: not swapped for a link meanwhile.
      const now = lstatOrNull(dir);
      if (now !== null && (now.isSymbolicLink() || !now.isDirectory())) return unsafeQueueDir();
      let created = false;
      let moved = now === null ? 'gone' : renameInto(temp, path);
      if (moved === 'gone') {
        // No queue directory (it was taken): create one and move the item in at once.
        try {
          mkdirSync(dir, { mode: 0o755 });
          created = true;
        } catch (error) {
          const code = errorCode(error);
          if (code === 'ENOENT') {
            // `.diffcity` itself went away: make it again (or refuse what took its place).
            const again = ensureOwnDir(own);
            if ('ok' in again) return again;
            continue;
          }
          if (code !== 'EEXIST') throw error;
        }
        moved = renameInto(temp, path);
      }
      if (moved === 'gone') continue;
      if (moved !== 'ok') return moved;
      if (created) fixMode(dir);
      return { ok: true, queued: true, count: contents.count + 1 };
    }
    return refuse('fix-queue-busy', `${QUEUE_LABEL} was taken while the fix was queued, ${String(FIX_QUEUE_ATTEMPTS)} times; try again`);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Renamed into place, which is the normal case.
    }
  }
}
