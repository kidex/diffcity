// Edges of the fix-queue writer (ADR-036, DC-112) on real temporary
// directories: item files already over 1 MiB on disk, the byte cap counted in
// UTF-8 bytes, a single item over the cap, and `.diffcity` as a regular file.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendToFixQueue, FIX_QUEUE_MAX_BYTES, fixQueueItemName, type FindingQueueItem } from '../../../src/core/fix-queue/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-fixq-edge-'));
  dirs.push(dir);
  return dir;
}

function item(n: number, message = 'The stock count can go negative.'): FindingQueueItem {
  return {
    key: `f:${n.toString(16).padStart(16, '0')}`,
    file: 'src/depot/stock.ts',
    line: 9,
    severity: 'med',
    title: `Stock finding ${String(n)}`,
    message,
    queuedAt: '2026-10-07T09:00:00.000Z',
  };
}

const queueDir = (root: string): string => join(root, '.diffcity', 'fix-queue');
const totalBytes = (root: string): number => readdirSync(queueDir(root)).reduce((sum, name) => sum + statSync(join(queueDir(root), name)).size, 0);

describe('fix queue writer edges', () => {
  it('item files already over 1 MiB on disk: fix-queue-full and left byte for byte; a key already queued is still not queued again', () => {
    const root = tree();
    mkdirSync(queueDir(root), { recursive: true });
    const content = JSON.stringify(item(1, 'x'.repeat(FIX_QUEUE_MAX_BYTES + 10)));
    writeFileSync(join(queueDir(root), fixQueueItemName(item(1).key)), content);
    expect(appendToFixQueue(root, item(2))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(readFileSync(join(queueDir(root), fixQueueItemName(item(1).key)), 'utf8')).toBe(content);
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: false, count: 1 });
  });

  it('the 1 MiB cap counts UTF-8 bytes: multibyte messages never push the queue past it', () => {
    const root = tree();
    // 4-byte characters: 60,000 of them are 240,000 bytes but only 120,000 UTF-16 units.
    const wide = '\u{1F4E6}'.repeat(60_000);
    const results = Array.from({ length: 6 }, (_, n) => appendToFixQueue(root, item(n + 1, wide)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.slice(4)).toEqual([
      expect.objectContaining({ ok: false, code: 'fix-queue-full' }),
      expect.objectContaining({ ok: false, code: 'fix-queue-full' }),
    ]);
    expect(totalBytes(root)).toBeLessThanOrEqual(FIX_QUEUE_MAX_BYTES);
  });

  it('a single item over 1 MiB is refused before anything is created', () => {
    const root = tree();
    expect(appendToFixQueue(root, item(1, 'z'.repeat(FIX_QUEUE_MAX_BYTES)))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(readdirSync(root)).toEqual([]);
  });

  it('a refusal over the cap leaves no temporary file in the queue directory', () => {
    const root = tree();
    const big = 'y'.repeat(600 * 1024);
    expect(appendToFixQueue(root, item(1, big))).toMatchObject({ ok: true, queued: true });
    expect(appendToFixQueue(root, item(2, big))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(readdirSync(queueDir(root))).toEqual([fixQueueItemName(item(1).key)]);
  });

  it('.diffcity as an empty regular file is fix-queue-unsafe and stays a file', () => {
    const root = tree();
    writeFileSync(join(root, '.diffcity'), '');
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(statSync(join(root, '.diffcity')).isFile()).toBe(true);
  });

  it('a leftover single-file queue of the first design is a plain file the writer ignores', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'));
    writeFileSync(join(root, '.diffcity', 'fix-queue.json'), '{"version":1,"items":[]}\n');
    expect(appendToFixQueue(root, item(1))).toEqual({ ok: true, queued: true, count: 1 });
    expect(readFileSync(join(root, '.diffcity', 'fix-queue.json'), 'utf8')).toBe('{"version":1,"items":[]}\n');
  });
});
