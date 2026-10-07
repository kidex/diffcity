// DC-109: /diffcity-review takes the fix queue by renaming it away (ADR-037).
// When that rename lands between the daemon's read and its write, the append
// must not write the taken items back. node:fs is wrapped so a test can act
// right after the temporary file is written, that is between the read and the
// rename into place.

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIX_QUEUE_ATTEMPTS, appendToFixQueue, type FindingQueueItem, type FixQueue } from '../../../src/core/fix-queue/index.js';

/** Runs once per temporary file the writer creates, right after it is written. */
const hooks: { afterTempWrite: ((count: number) => void) | null; writes: number; linkError: string | null } = { afterTempWrite: null, writes: 0, linkError: null };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    actual.writeFileSync(file, data, options);
    if (typeof file === 'string' && file.endsWith('.tmp') && hooks.afterTempWrite !== null) {
      hooks.writes++;
      hooks.afterTempWrite(hooks.writes);
    }
  };
  // A filesystem without hard links (exFAT, some FUSE mounts) refuses link.
  const linkSync: typeof actual.linkSync = (existing, created) => {
    if (hooks.linkError !== null) throw Object.assign(new Error(`${hooks.linkError}: operation not permitted, link`), { code: hooks.linkError });
    actual.linkSync(existing, created);
  };
  return { ...actual, writeFileSync, linkSync };
});

const dirs: string[] = [];
afterEach(() => {
  hooks.afterTempWrite = null;
  hooks.writes = 0;
  hooks.linkError = null;
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

const queuePath = (root: string): string => join(root, '.diffcity', 'fix-queue.json');
const takingPath = (root: string): string => join(root, '.diffcity', 'fix-queue.taking.json');
const readJson = (path: string): FixQueue => JSON.parse(fs.readFileSync(path, 'utf8')) as FixQueue;
const leftovers = (root: string): string[] => fs.readdirSync(join(root, '.diffcity')).filter((name) => name.endsWith('.tmp'));

describe('fix queue against /diffcity-review taking it (DC-109)', () => {
  it('fix-queue/taken-between-read-and-write: the new queue holds only the new item; the taken one is not written back', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true, queued: true, count: 1 });

    // The review renames the queue away after the daemon read it, before the daemon's rename.
    hooks.afterTempWrite = (count) => {
      if (count === 1) fs.renameSync(queuePath(root), takingPath(root));
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 1 });
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(2).key]);
    expect(readJson(takingPath(root)).items.map((entry) => entry.key)).toEqual([item(1).key]);
    expect(hooks.writes).toBe(2);
    expect(leftovers(root)).toEqual([]);
  });

  it('fix-queue/changed-between-read-and-write: an item written meanwhile is kept, read again', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true });
    hooks.afterTempWrite = (count) => {
      if (count === 1) fs.writeFileSync(queuePath(root), `${JSON.stringify({ version: 1, items: [item(1), item(3)] }, null, 2)}\n`);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 3 });
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(1).key, item(3).key, item(2).key]);
  });

  it('fix-queue/created-meanwhile: with no queue at the read, one that appears before the write is never overwritten', () => {
    const root = tree();
    fs.mkdirSync(join(root, '.diffcity'));
    hooks.afterTempWrite = (count) => {
      if (count === 1) fs.writeFileSync(queuePath(root), `${JSON.stringify({ version: 1, items: [item(5)] }, null, 2)}\n`);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(5).key, item(2).key]);
    expect(leftovers(root)).toEqual([]);
  });

  it('fix-queue/busy: a queue that changes under every attempt is refused with fix-queue-busy, nothing written back', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: true });
    hooks.afterTempWrite = (count) => {
      fs.writeFileSync(queuePath(root), `${JSON.stringify({ version: 1, items: Array.from({ length: count }, (_, n) => item(10 + n)) }, null, 2)}\n`);
    };
    const result = appendToFixQueue(root, item(2));
    expect(result).toEqual({ ok: false, code: 'fix-queue-busy', message: '.diffcity/fix-queue.json kept changing while the fix was queued; try again' });
    expect(hooks.writes).toBe(FIX_QUEUE_ATTEMPTS);
    // The last queue the other writer left is untouched, without the new item.
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(10).key, item(11).key, item(12).key]);
    expect(leftovers(root)).toEqual([]);
  });

  it.each(['EPERM', 'ENOTSUP'])('fix-queue/no-hard-links: link failing with %s falls back to a rename; the queue is still written', (code) => {
    const root = tree();
    hooks.linkError = code;
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(1).key]);
    expect(leftovers(root)).toEqual([]);
    // A queue that appears before the fallback rename is still never overwritten.
    fs.rmSync(queuePath(root));
    hooks.afterTempWrite = (count) => {
      if (count === 1) fs.writeFileSync(queuePath(root), `${JSON.stringify({ version: 1, items: [item(5)] }, null, 2)}\n`);
    };
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    expect(readJson(queuePath(root)).items.map((entry) => entry.key)).toEqual([item(5).key, item(2).key]);
    expect(leftovers(root)).toEqual([]);
  });

  it('another link error is not swallowed', () => {
    const root = tree();
    hooks.linkError = 'EIO';
    expect(() => appendToFixQueue(root, item(1))).toThrow('EIO');
    expect(leftovers(root)).toEqual([]);
  });

  it('a quiet queue is written in one attempt', () => {
    const root = tree();
    hooks.afterTempWrite = () => undefined;
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
    expect(appendToFixQueue(root, item(2))).toEqual({ ok: true, queued: true, count: 2 });
    expect(hooks.writes).toBe(2);
    expect(fs.statSync(queuePath(root)).nlink).toBe(1);
  });
});
