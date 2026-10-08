// The fix-queue writer (ADR-036, DC-112) on real temporary directories and
// real symbolic links: `<working tree>/.diffcity/fix-queue/<id>.json`, one
// version 1 item per file, idempotent per key, at most 100 items and 1 MiB,
// refused through symlinks.

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendToFixQueue,
  FIX_QUEUE_MAX_BYTES,
  FIX_QUEUE_MAX_ITEMS,
  fixQueueItem,
  fixQueueItemName,
  fixQueueRoot,
  type FindingQueueItem,
  type FixQueueItem,
} from '../../../src/core/fix-queue/index.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { shopfrontReport } from '../findings/support.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory standing for a working tree. */
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-fixq-'));
  dirs.push(dir);
  return dir;
}

const AT = '2026-10-07T09:00:00.000Z';

function item(n: number, extra: Partial<FindingQueueItem> = {}): FindingQueueItem {
  return {
    key: `f:${n.toString(16).padStart(16, '0')}`,
    file: 'src/auth/order.guard.ts',
    line: 14,
    symbol: 'canCancel',
    severity: 'high',
    title: `Finding ${String(n)}`,
    message: 'When order is undefined the guard returns true.',
    fix: 'Return false when order is undefined.',
    queuedAt: AT,
    ...extra,
  };
}

const queueDir = (root: string): string => join(root, '.diffcity', 'fix-queue');
const itemPath = (root: string, key: string): string => join(queueDir(root), fixQueueItemName(key));
/** The queued items, read back from their files, in key order. */
const readQueue = (root: string): FixQueueItem[] =>
  readdirSync(queueDir(root))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(queueDir(root), name), 'utf8')) as FixQueueItem)
    .sort((a, b) => a.key.localeCompare(b.key));

describe('fix queue writer', () => {
  it('fix-queue/append-idempotent: creates .diffcity and fix-queue (0755) and one file per item; a repeated key changes nothing', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o755);
    expect(statSync(queueDir(root)).mode & 0o777).toBe(0o755);
    // The item file is the version 1 item itself, without an envelope.
    expect(JSON.parse(readFileSync(itemPath(root, item(1).key), 'utf8'))).toEqual(item(1));

    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    const before = readFileSync(itemPath(root, item(1).key), 'utf8');
    expect(appendToFixQueue(root, item(1, { title: 'changed' }))).toEqual({ ok: true, queued: false, count: 2 });
    expect(readFileSync(itemPath(root, item(1).key), 'utf8')).toBe(before);
    expect(readQueue(root).map((i) => i.key)).toEqual([item(1).key, item(2).key]);
    // Written by rename: no temporary file is left behind.
    expect(readdirSync(queueDir(root)).sort()).toEqual([fixQueueItemName(item(1).key), fixQueueItemName(item(2).key)].sort());
    expect(readdirSync(join(root, '.diffcity'))).toEqual(['fix-queue']);
  });

  it('fixQueueItemName: 32 hex digits of the key, file-name safe, the same for the same key', () => {
    for (const key of ['f:00000000000000aa', 'rule:file-size:0123abcd', 'summary:1', '../../etc/passwd', 'a/b\\c:d']) {
      expect(fixQueueItemName(key)).toMatch(/^[0-9a-f]{32}\.json$/);
      expect(fixQueueItemName(key)).toBe(fixQueueItemName(key));
    }
    expect(fixQueueItemName('f:1')).not.toBe(fixQueueItemName('f:2'));
  });

  it('a key taken by the slash command can be queued again', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true });
    rmSync(queueDir(root), { recursive: true });
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
  });

  it('creates .diffcity and the queue directory with mode 0755 even under a strict umask', () => {
    const root = tree();
    const previous = process.umask(0o077);
    try {
      expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true });
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o755);
    expect(statSync(queueDir(root)).mode & 0o777).toBe(0o755);
  });

  it('keeps an existing .diffcity and its other files, and accepts a review-summary item', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'), { mode: 0o700 });
    writeFileSync(join(root, '.diffcity', 'spec.md'), '# Spec\n');
    const summary: FixQueueItem = { kind: 'review-summary', key: 'summary:1', message: '# Review\n\n- fix it', queuedAt: AT };
    expect(appendToFixQueue(root, summary)).toEqual({ ok: true, queued: true, count: 1 });
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o700);
    expect(readQueue(root)).toEqual([summary]);
    expect(readFileSync(join(root, '.diffcity', 'spec.md'), 'utf8')).toBe('# Spec\n');
  });

  it('fix-queue/symlink-dir-refused: .diffcity as a symbolic link to a directory is refused and nothing is written there', () => {
    const root = tree();
    const elsewhere = tree();
    symlinkSync(elsewhere, join(root, '.diffcity'), 'dir');
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('fix-queue/symlink-dir-refused: .diffcity as a regular file is refused', () => {
    const root = tree();
    writeFileSync(join(root, '.diffcity'), 'not a directory');
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
  });

  it('fix-queue/symlink-queue-dir-refused: .diffcity/fix-queue as a link (to a directory, dangling) or a file is refused; nothing is written through it', () => {
    const root = tree();
    const elsewhere = tree();
    mkdirSync(join(root, '.diffcity'));
    symlinkSync(elsewhere, queueDir(root), 'dir');
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(queueDir(root)).isSymbolicLink()).toBe(true);

    const dangling = tree();
    mkdirSync(join(dangling, '.diffcity'));
    symlinkSync(join(dangling, 'missing'), queueDir(dangling), 'dir');
    expect(appendToFixQueue(dangling, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readdirSync(dangling)).toEqual(['.diffcity']);

    const file = tree();
    mkdirSync(join(file, '.diffcity'));
    writeFileSync(queueDir(file), '{"version":1,"items":[]}');
    expect(appendToFixQueue(file, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readFileSync(queueDir(file), 'utf8')).toBe('{"version":1,"items":[]}');
  });

  it('fix-queue/symlink-file-refused: an item file that is a link (or a directory) is refused and its target is untouched', () => {
    const root = tree();
    const elsewhere = tree();
    const target = join(elsewhere, 'target.json');
    writeFileSync(target, '{}');
    mkdirSync(queueDir(root), { recursive: true });
    symlinkSync(target, itemPath(root, item(1).key));
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readFileSync(target, 'utf8')).toBe('{}');
    expect(lstatSync(itemPath(root, item(1).key)).isSymbolicLink()).toBe(true);

    const other = tree();
    mkdirSync(itemPath(other, item(1).key), { recursive: true });
    expect(appendToFixQueue(other, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
  });

  it('fix-queue/no-working-tree-refused: no working tree, or one that is gone, cannot queue', () => {
    expect(appendToFixQueue(null, item(1))).toMatchObject({ ok: false, code: 'no-working-tree' });
    const root = tree();
    rmSync(root, { recursive: true });
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'no-working-tree' });
  });

  it('fix-queue/cap-fits-glob: at most 100 items, the most Claude Code 2.1.288 Glob lists at once', () => {
    // /diffcity-review lists the taken items with Glob, which shows at most 100 files,
    // and then removes the taken directory: a larger queue could lose items unapplied.
    expect(FIX_QUEUE_MAX_ITEMS).toBeLessThanOrEqual(100);
  });

  it('fix-queue/cap-100: the 101st item is refused, a repeated key is still fine', () => {
    const root = tree();
    for (let n = 1; n <= FIX_QUEUE_MAX_ITEMS; n += 1) {
      expect(appendToFixQueue(root, item(n))).toMatchObject({ ok: true, queued: true });
    }
    expect(FIX_QUEUE_MAX_ITEMS).toBe(100);
    expect(appendToFixQueue(root, item(101))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(appendToFixQueue(root, item(7))).toEqual({ ok: true, queued: false, count: 100 });
    expect(readQueue(root)).toHaveLength(100);
  });

  it('fix-queue/cap-1mib: a queue that would pass 1 MiB is refused', () => {
    const root = tree();
    const big = 'x'.repeat(250 * 1024);
    let refused = 0;
    for (let n = 1; n <= 6; n += 1) {
      const result = appendToFixQueue(root, item(n, { message: big }));
      if (!result.ok) {
        expect(result.code).toBe('fix-queue-full');
        refused += 1;
      }
    }
    expect(FIX_QUEUE_MAX_BYTES).toBe(1024 * 1024);
    expect(refused).toBe(2);
    const total = readdirSync(queueDir(root)).reduce((sum, name) => sum + statSync(join(queueDir(root), name)).size, 0);
    expect(total).toBeLessThanOrEqual(FIX_QUEUE_MAX_BYTES);
  });

  it('other files in the queue directory are not items: they neither count nor block', () => {
    const root = tree();
    mkdirSync(queueDir(root), { recursive: true });
    writeFileSync(join(queueDir(root), 'notes.txt'), 'x'.repeat(FIX_QUEUE_MAX_BYTES));
    writeFileSync(join(queueDir(root), '.stale.json.1.0123456789ab.tmp'), '{');
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
  });
});

describe('fixQueueItem', () => {
  const finding: Finding = {
    id: 'f:00000000000000aa',
    source: 'claude',
    severity: 'high',
    category: 'security',
    file: 'src/auth/order.guard.ts',
    line: 14,
    symbolId: 'src/auth/order.guard.ts#canCancel',
    title: 'Optional order defaults to allow',
    message: 'When order is undefined the guard returns true.',
    fix: 'Return false.',
    state: 'open',
  };

  it('takes the served finding and the name of its symbol', () => {
    expect(fixQueueItem(shopfrontReport(), finding, AT)).toEqual({
      key: 'f:00000000000000aa',
      file: 'src/auth/order.guard.ts',
      line: 14,
      symbol: 'canCancel',
      severity: 'high',
      title: 'Optional order defaults to allow',
      message: 'When order is undefined the guard returns true.',
      fix: 'Return false.',
      queuedAt: AT,
    });
  });

  it('leaves out symbol and fix when the finding has none', () => {
    const report: Report = shopfrontReport();
    const plain: Finding = { ...finding };
    delete plain.symbolId;
    delete plain.fix;
    expect(fixQueueItem(report, plain, AT)).toEqual({
      key: 'f:00000000000000aa',
      file: 'src/auth/order.guard.ts',
      line: 14,
      severity: 'high',
      title: 'Optional order defaults to allow',
      message: 'When order is undefined the guard returns true.',
      queuedAt: AT,
    });
  });
});

describe('fixQueueRoot', () => {
  it('the working tree at the change head; none when no working tree has it checked out, whatever the kind', () => {
    expect(fixQueueRoot({ worktreePath: '/work/shopfront-wt' })).toBe('/work/shopfront-wt');
    // worktreePath is null only when no working tree is at the change head: the repo
    // path would be another commit, so a branch, a PR or a draft without one cannot queue.
    expect(fixQueueRoot({ worktreePath: null })).toBeNull();
  });
});
