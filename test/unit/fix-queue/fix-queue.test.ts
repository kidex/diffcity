// The fix-queue writer (ADR-036) on real temporary directories and real
// symbolic links: `<working tree>/.diffcity/fix-queue.json`, format version 1,
// idempotent per key, at most 200 items and 1 MiB, refused through symlinks.

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendToFixQueue,
  FIX_QUEUE_MAX_BYTES,
  FIX_QUEUE_MAX_ITEMS,
  fixQueueItem,
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

const queuePath = (root: string): string => join(root, '.diffcity', 'fix-queue.json');
const readQueue = (root: string): { version: number; items: FixQueueItem[] } =>
  JSON.parse(readFileSync(queuePath(root), 'utf8')) as { version: number; items: FixQueueItem[] };

describe('fix queue writer', () => {
  it('fix-queue/append-idempotent: creates .diffcity (0755) and the file, appends, and a repeated key changes nothing', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o755);
    expect(readQueue(root)).toEqual({ version: 1, items: [item(1)] });

    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    const before = readFileSync(queuePath(root), 'utf8');
    expect(appendToFixQueue(root, item(1, { title: 'changed' }))).toEqual({ ok: true, queued: false, count: 2 });
    expect(readFileSync(queuePath(root), 'utf8')).toBe(before);
    expect(readQueue(root).items.map((i) => i.key)).toEqual([item(1).key, item(2).key]);
    // Written by rename: no temporary file is left behind.
    expect(readdirSync(join(root, '.diffcity'))).toEqual(['fix-queue.json']);
  });

  it('creates .diffcity with mode 0755 even under a strict umask', () => {
    const root = tree();
    const previous = process.umask(0o077);
    try {
      expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true });
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o755);
  });

  it('keeps an existing .diffcity and its other files, and accepts a review-summary item', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'), { mode: 0o700 });
    writeFileSync(join(root, '.diffcity', 'spec.md'), '# Spec\n');
    const summary: FixQueueItem = { kind: 'review-summary', key: 'summary:1', message: '# Review\n\n- fix it', queuedAt: AT };
    expect(appendToFixQueue(root, summary)).toEqual({ ok: true, queued: true, count: 1 });
    expect(statSync(join(root, '.diffcity')).mode & 0o777).toBe(0o700);
    expect(readQueue(root).items).toEqual([summary]);
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

  it('fix-queue/symlink-file-refused: fix-queue.json as a symbolic link is refused and its target is untouched', () => {
    const root = tree();
    const elsewhere = tree();
    const target = join(elsewhere, 'target.json');
    writeFileSync(target, '{"version":1,"items":[]}');
    mkdirSync(join(root, '.diffcity'));
    symlinkSync(target, queuePath(root));
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readFileSync(target, 'utf8')).toBe('{"version":1,"items":[]}');
    expect(lstatSync(queuePath(root)).isSymbolicLink()).toBe(true);
  });

  it('fix-queue/symlink-file-refused: a dangling link and a directory in its place are refused', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'));
    symlinkSync(join(root, 'missing.json'), queuePath(root));
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(readdirSync(root)).toEqual(['.diffcity']);

    const other = tree();
    mkdirSync(queuePath(other), { recursive: true });
    expect(appendToFixQueue(other, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
  });

  it('fix-queue/no-working-tree-refused: no working tree, or one that is gone, cannot queue', () => {
    expect(appendToFixQueue(null, item(1))).toMatchObject({ ok: false, code: 'no-working-tree' });
    const root = tree();
    rmSync(root, { recursive: true });
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'no-working-tree' });
  });

  it('fix-queue/cap-200: the 201st item is refused, a repeated key is still fine', () => {
    const root = tree();
    for (let n = 1; n <= FIX_QUEUE_MAX_ITEMS; n += 1) {
      expect(appendToFixQueue(root, item(n))).toMatchObject({ ok: true, queued: true });
    }
    expect(FIX_QUEUE_MAX_ITEMS).toBe(200);
    expect(appendToFixQueue(root, item(201))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(appendToFixQueue(root, item(7))).toEqual({ ok: true, queued: false, count: 200 });
    expect(readQueue(root).items).toHaveLength(200);
  });

  it('fix-queue/cap-200: a queue that would pass 1 MiB is refused', () => {
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
    expect(statSync(queuePath(root)).size).toBeLessThanOrEqual(FIX_QUEUE_MAX_BYTES);
  });

  it('an existing file that is not a version 1 queue is refused and left as it is', () => {
    for (const content of ['not json', '{"version":2,"items":[]}', '{"version":1}', '[]']) {
      const root = tree();
      mkdirSync(join(root, '.diffcity'));
      writeFileSync(queuePath(root), content);
      expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-invalid' });
      expect(readFileSync(queuePath(root), 'utf8')).toBe(content);
    }
  });

  it('an emptied queue (the slash command read it) takes new items', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'));
    writeFileSync(queuePath(root), '{"version":1,"items":[]}\n');
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
