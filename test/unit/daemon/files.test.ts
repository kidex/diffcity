// The single-instance lock and the daemon files in DIFFCITY_HOME (ADR-015).

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import {
  acquireLock,
  DEFAULT_PORT,
  isProcessAlive,
  readDaemonInfo,
  readState,
  releaseLock,
  removeDaemonFiles,
  resolvePort,
  writeDaemonInfo,
  writeState,
} from '../../../src/daemon/files.js';

let root: string;
let paths: HomePaths;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dc-files-'));
  paths = homePaths(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

describe('lock', () => {
  it('creates the lock with our pid', async () => {
    const result = await acquireLock(paths, { pid: 4242, isAlive: () => false });
    expect(result).toEqual({ acquired: true });
    expect(await readFile(paths.lock, 'utf8')).toBe('4242\n');
  });

  it('reports the owner when the lock belongs to a live process', async () => {
    await writeFile(paths.lock, '777\n');
    const result = await acquireLock(paths, { pid: 4242, isAlive: (pid) => pid === 777 });
    expect(result).toEqual({ acquired: false, owner: 777 });
    expect(await readFile(paths.lock, 'utf8')).toBe('777\n');
  });

  it('daemon/stale-lock: recovers a lock whose pid is dead, removing the stale socket', async () => {
    const dead = deadPid();
    await writeFile(paths.lock, `${String(dead)}\n`);
    await writeFile(paths.socket, '');
    const result = await acquireLock(paths, { pid: 4242, isAlive: isProcessAlive });
    expect(result).toEqual({ acquired: true });
    expect(await readFile(paths.lock, 'utf8')).toBe('4242\n');
    await expect(stat(paths.socket)).rejects.toThrow(/ENOENT/);
  });

  it('treats an unreadable lock that stays unreadable as stale', async () => {
    await writeFile(paths.lock, 'garbage');
    const result = await acquireLock(paths, { pid: 4242, isAlive: () => true, unreadableGraceMs: 20 });
    expect(result).toEqual({ acquired: true });
  });

  it('releases only a lock it owns', async () => {
    await writeFile(paths.lock, '777\n');
    await releaseLock(paths, 4242);
    expect(await readFile(paths.lock, 'utf8')).toBe('777\n');
    await releaseLock(paths, 777);
    await expect(stat(paths.lock)).rejects.toThrow(/ENOENT/);
  });

  it('isProcessAlive: true for this process, false for an exited one', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });
});

describe('daemon.json and state.json', () => {
  const info = { pid: 1, port: 4321, socket: '/tmp/x.sock', version: '1.0.0', startedAt: '2026-01-01T00:00:00.000Z' };

  it('round-trips daemon.json and returns null when missing or malformed', async () => {
    expect(await readDaemonInfo(paths)).toBeNull();
    await writeDaemonInfo(paths, info);
    expect(await readDaemonInfo(paths)).toEqual(info);
    await writeFile(paths.daemonJson, '{"pid":"x"}');
    expect(await readDaemonInfo(paths)).toBeNull();
  });

  it('round-trips state.json and ignores an invalid port', async () => {
    expect(await readState(paths)).toBeNull();
    await writeState(paths, { port: 5000 });
    expect(await readState(paths)).toEqual({ port: 5000 });
    await writeFile(paths.state, '{"port":70000}');
    expect(await readState(paths)).toBeNull();
  });

  it('resolvePort: explicit, then state.json, then 4321', async () => {
    expect(DEFAULT_PORT).toBe(4321);
    expect(await resolvePort(paths, undefined)).toBe(4321);
    await writeState(paths, { port: 5000 });
    expect(await resolvePort(paths, undefined)).toBe(5000);
    expect(await resolvePort(paths, 0)).toBe(0);
  });

  it('removeDaemonFiles removes daemon.json, the socket and the lock, tolerating missing ones', async () => {
    await writeDaemonInfo(paths, info);
    await writeFile(paths.lock, '1\n');
    await removeDaemonFiles(paths, paths.socket, 1);
    for (const file of [paths.daemonJson, paths.lock]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it("removeDaemonFiles leaves another daemon's daemon.json and lock alone", async () => {
    await writeDaemonInfo(paths, { ...info, pid: 2 });
    await writeFile(paths.lock, '2\n');
    await removeDaemonFiles(paths, paths.socket, 1);
    expect(await readDaemonInfo(paths)).toEqual({ ...info, pid: 2 });
    expect(await readFile(paths.lock, 'utf8')).toBe('2\n');
  });
});
