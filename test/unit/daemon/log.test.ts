// daemon.log is rotated at 5 MB with one previous file kept (ADR-015).

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLogger, LOG_MAX_BYTES } from '../../../src/daemon/log.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-log-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('daemon log', () => {
  it('rotates at 5 MB by default', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('writes timestamped lines with the level', async () => {
    const path = join(dir, 'daemon.log');
    const log = createFileLogger(path);
    log.info('daemon started');
    log.error('something failed');
    log.close();
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z info daemon started$/);
    expect(lines[1]).toMatch(/ error something failed$/);
  });

  it('moves the log to daemon.log.1 when the next line would pass the limit, keeping one previous file', async () => {
    const path = join(dir, 'daemon.log');
    await writeFile(`${path}.1`, 'oldest\n');
    const log = createFileLogger(path, { maxBytes: 200 });
    for (let i = 0; i < 12; i++) log.info(`line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}`);
    log.close();
    expect((await stat(path)).size).toBeLessThanOrEqual(200);
    const previous = await readFile(`${path}.1`, 'utf8');
    expect(previous).not.toContain('oldest');
    expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(200);
    const current = await readFile(path, 'utf8');
    expect(current).toContain('line 11');
  });

  it('appends to an existing log and counts its size', async () => {
    const path = join(dir, 'daemon.log');
    await writeFile(path, 'a'.repeat(190) + '\n');
    const log = createFileLogger(path, { maxBytes: 200 });
    log.info('next');
    log.close();
    expect(await readFile(`${path}.1`, 'utf8')).toBe('a'.repeat(190) + '\n');
    expect(await readFile(path, 'utf8')).toMatch(/ info next\n$/);
  });
});
