// DC-112: /diffcity-review takes the fix queue by renaming its directory
// away (ADR-037). node:fs is wrapped so a test can take the queue at chosen
// moments of an append: right before the item's rename into the queue, after
// the temporary file is written, and while the directory is listed. The item
// must land exactly once: in the taken directory if its rename came first,
// otherwise in a fresh queue directory.

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIX_QUEUE_ATTEMPTS, appendToFixQueue, fixQueueItemName, type FindingQueueItem } from '../../../src/core/fix-queue/index.js';

const hooks: {
  afterTempWrite: ((count: number) => void) | null;
  beforeRename: ((count: number) => void) | null;
  beforeReaddir: ((count: number) => void) | null;
  writes: number;
  renames: number;
  listings: number;
} = { afterTempWrite: null, beforeRename: null, beforeReaddir: null, writes: 0, renames: 0, listings: 0 };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    actual.writeFileSync(file, data, options);
    if (typeof file === 'string' && file.endsWith('.tmp') && hooks.afterTempWrite !== null) {
      hooks.writes++;
      hooks.afterTempWrite(hooks.writes);
    }
  };
  // Typed loosely: readdirSync has many overloads and the writer uses the plain one.
  const readdirSync = ((path: fs.PathLike, ...rest: unknown[]) => {
    if (hooks.beforeReaddir !== null) {
      hooks.listings++;
      hooks.beforeReaddir(hooks.listings);
    }
    return (actual.readdirSync as (path: fs.PathLike, ...rest: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readdirSync;
  const renameSync: typeof actual.renameSync = (from, to) => {
    if (typeof from === 'string' && from.endsWith('.tmp') && hooks.beforeRename !== null) {
      hooks.renames++;
      hooks.beforeRename(hooks.renames);
    }
    actual.renameSync(from, to);
  };
  return { ...actual, writeFileSync, readdirSync, renameSync };
});

const dirs: string[] = [];
afterEach(() => {
  hooks.afterTempWrite = null;
  hooks.beforeRename = null;
  hooks.beforeReaddir = null;
  hooks.writes = 0;
  hooks.renames = 0;
  hooks.listings = 0;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dc-fixq-race-'));
  dirs.push(dir);
  return dir;
}

function item(n: number): FindingQueueItem {
  return {
    key: `f:${n.toString(16).padStart(16, '0')}`,
    file: 'src/cart/total.ts',
    line: 3,
    severity: 'high',
    title: `Invented finding ${String(n)}`,
    message: 'An invented finding.',
    queuedAt: '2026-10-08T09:00:00.000Z',
  };
}

const queueDir = (root: string): string => join(root, '.diffcity', 'fix-queue');
const takenDir = (root: string, n: number): string => join(root, '.diffcity', `taken-${String(n)}`);
const take = (root: string, n: number): void => {
  fs.renameSync(queueDir(root), takenDir(root, n));
};
/** The keys of the item files in `dir`, sorted; temporary files are not items. */
const keysIn = (dir: string): string[] =>
  fs
    .readdirSync(dir)
    .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
    .map((name) => (JSON.parse(fs.readFileSync(join(dir, name), 'utf8')) as { key: string }).key)
    .sort();

describe('fix queue against /diffcity-review taking it (DC-112)', () => {
  it('fix-queue/taken-before-rename: the queue taken right before the item rename: the item goes to a fresh directory; the taken one keeps only what it had', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true });
    hooks.beforeRename = (count) => {
      if (count === 1) take(root, 1);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    expect(keysIn(queueDir(root))).toEqual([item(2).key]);
    expect(keysIn(takenDir(root, 1))).toEqual([item(1).key]);
    // The temporary file was written once and renamed on the second try.
    expect(hooks.renames).toBe(2);
    expect(fs.readdirSync(queueDir(root))).toEqual([fixQueueItemName(item(2).key)]);
    expect(fs.readdirSync(join(root, '.diffcity')).sort()).toEqual(['fix-queue', 'taken-1']);
  });

  it('fix-queue/taken-after-temp-write: the queue taken after the temporary write goes the same way', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true });
    hooks.afterTempWrite = (count) => {
      if (count === 1) take(root, 1);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    expect(keysIn(queueDir(root))).toEqual([item(2).key]);
    expect(keysIn(takenDir(root, 1))).toEqual([item(1).key]);
    expect(hooks.writes).toBe(1);
  });

  it('fix-queue/taken-while-listed: the queue taken while it is listed is written again, never refused', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true });
    hooks.beforeReaddir = (count) => {
      if (count === 1) take(root, 1);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 1 });
    expect(keysIn(queueDir(root))).toEqual([item(2).key]);
    expect(keysIn(takenDir(root, 1))).toEqual([item(1).key]);
  });

  it('a key still queued is not written again: no temporary file, so no take', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true });
    hooks.afterTempWrite = (count) => {
      if (count === 1) take(root, 1);
    };
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: false, count: 1 });
    // Already queued: nothing written, so the take hook never ran.
    expect(hooks.writes).toBe(0);
  });

  it('fix-queue/busy: a queue taken before every rename gives fix-queue-busy; the item is in none of the queues and no temporary file is left', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true });
    hooks.beforeRename = (count) => {
      take(root, count);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({
      ok: false,
      code: 'fix-queue-busy',
      message: '.diffcity/fix-queue was taken while the fix was queued, 3 times; try again',
    });
    // The first attempt renames into the queue it saw, then into the one it made;
    // the next ones find no queue and rename once, into the one they make.
    expect(hooks.renames).toBe(FIX_QUEUE_ATTEMPTS + 1);
    expect(keysIn(takenDir(root, 1))).toEqual([item(1).key]);
    for (let n = 2; n <= hooks.renames; n++) expect(keysIn(takenDir(root, n))).toEqual([]);
    expect(fs.existsSync(queueDir(root))).toBe(false);
    expect(fs.readdirSync(join(root, '.diffcity')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('the queue directory swapped for a link after the temporary write is refused, nothing written through it', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(3))).toMatchObject({ ok: true });
    const elsewhere = tree();
    hooks.afterTempWrite = (count) => {
      if (count === 1) {
        take(root, 1);
        fs.symlinkSync(elsewhere, queueDir(root), 'dir');
      }
    };
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
