// Edges of the fix-queue writer (ADR-036) on real temporary directories: a
// queue already over 1 MiB on disk, the byte cap counted in UTF-8 bytes, a
// valid queue of another version, and `.diffcity` as a regular file.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendToFixQueue, FIX_QUEUE_MAX_BYTES, type FindingQueueItem } from '../../../src/core/fix-queue/index.js';

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

const queuePath = (root: string): string => join(root, '.diffcity', 'fix-queue.json');

describe('fix queue writer edges', () => {
  it('a version 1 queue already over 1 MiB on disk is fix-queue-full and left byte for byte', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'));
    const content = JSON.stringify({ version: 1, items: [item(1, 'x'.repeat(FIX_QUEUE_MAX_BYTES + 10))] });
    writeFileSync(queuePath(root), content);
    expect(appendToFixQueue(root, item(2))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(readFileSync(queuePath(root), 'utf8')).toBe(content);
    // Even a key already in it: the oversized file is not read.
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-full' });
  });

  it('the 1 MiB cap counts UTF-8 bytes: multibyte messages never push the file past it', () => {
    const root = tree();
    // 4-byte characters: 60,000 of them are 240,000 bytes but only 120,000 UTF-16 units.
    const wide = '\u{1F4E6}'.repeat(60_000);
    const results = Array.from({ length: 6 }, (_, n) => appendToFixQueue(root, item(n + 1, wide)));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.slice(4)).toEqual([
      expect.objectContaining({ ok: false, code: 'fix-queue-full' }),
      expect.objectContaining({ ok: false, code: 'fix-queue-full' }),
    ]);
    expect(statSync(queuePath(root)).size).toBeLessThanOrEqual(FIX_QUEUE_MAX_BYTES);
    const queue = JSON.parse(readFileSync(queuePath(root), 'utf8')) as { items: FindingQueueItem[] };
    expect(queue.items.map((i) => i.message)).toEqual([wide, wide, wide, wide]);
  });

  it('a valid queue of version 2 with items is fix-queue-invalid; no temporary file is left behind', () => {
    const root = tree();
    mkdirSync(join(root, '.diffcity'));
    const content = `${JSON.stringify({ version: 2, items: [item(7)] }, null, 2)}\n`;
    writeFileSync(queuePath(root), content);
    expect(appendToFixQueue(root, item(8))).toMatchObject({ ok: false, code: 'fix-queue-invalid' });
    expect(readFileSync(queuePath(root), 'utf8')).toBe(content);
    expect(readdirSync(join(root, '.diffcity'))).toEqual(['fix-queue.json']);
  });

  it('a refusal over the cap leaves no temporary file in .diffcity', () => {
    const root = tree();
    const big = 'y'.repeat(600 * 1024);
    expect(appendToFixQueue(root, item(1, big))).toMatchObject({ ok: true, queued: true });
    expect(appendToFixQueue(root, item(2, big))).toMatchObject({ ok: false, code: 'fix-queue-full' });
    expect(readdirSync(join(root, '.diffcity'))).toEqual(['fix-queue.json']);
  });

  it('.diffcity as an empty regular file is fix-queue-unsafe and stays a file', () => {
    const root = tree();
    writeFileSync(join(root, '.diffcity'), '');
    expect(appendToFixQueue(root, item(1))).toMatchObject({ ok: false, code: 'fix-queue-unsafe' });
    expect(statSync(join(root, '.diffcity')).isFile()).toBe(true);
  });
});
