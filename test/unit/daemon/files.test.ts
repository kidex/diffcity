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
  fileIdentity,
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

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

  it('daemon/stale-lock: recovers a lock whose pid is dead and leaves the socket to listen()', async () => {
    const dead = deadPid();
    await writeFile(paths.lock, `${String(dead)}\n`);
    await writeFile(paths.socket, '');
    const result = await acquireLock(paths, { pid: 4242, isAlive: isProcessAlive });
    expect(result).toEqual({ acquired: true });
    expect(await readFile(paths.lock, 'utf8')).toBe('4242\n');
    expect((await stat(paths.socket)).isFile()).toBe(true);
  });

  it('daemon/stale-lock-race: two staggered starters on a stale lock, exactly one acquires it', async () => {
    const dead = deadPid();
    const live = new Set([4242, 4343]);
    const isAlive = (pid: number): boolean => live.has(pid);
    for (let run = 0; run < 100; run++) {
      await writeFile(paths.lock, `${String(dead)}\n`);
      const delay = run % 5;
      const [a, b] = await Promise.all([
        acquireLock(paths, { pid: 4242, isAlive }),
        new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() => acquireLock(paths, { pid: 4343, isAlive })),
      ]);
      const winners = [a, b].filter((result) => result.acquired);
      expect(winners, `run ${String(run)}`).toHaveLength(1);
      const holder = a.acquired ? 4242 : 4343;
      expect(await readFile(paths.lock, 'utf8')).toBe(`${String(holder)}\n`);
      expect(a.acquired ? b : a).toEqual({ acquired: false, owner: holder });
      await rm(paths.lock, { force: true });
    }
  });

  it('daemon/stale-lock-race: a starter that judged the lock stale does not remove the lock another starter just took', async () => {
    const dead = deadPid();
    const live = new Set([4242, 4343]);
    const isAlive = (pid: number): boolean => live.has(pid);
    await writeFile(paths.lock, `${String(dead)}\n`);
    let releaseB = (): void => undefined;
    const bJudgedStale = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    // B judges the lock stale first, then is held until A has replaced it.
    const b = acquireLock(paths, {
      pid: 4343,
      isAlive,
      beforeTakeover: async () => {
        releaseB();
        await waitUntil(async () => (await readFile(paths.lock, 'utf8').catch(() => '')) === '4242\n');
      },
    });
    await bJudgedStale;
    const a = await acquireLock(paths, { pid: 4242, isAlive });
    expect(a).toEqual({ acquired: true });
    expect(await b).toEqual({ acquired: false, owner: 4242 });
    expect(await readFile(paths.lock, 'utf8')).toBe('4242\n');
  });

  it('a stale takeover guard left by a crashed starter is ignored after a few seconds', async () => {
    const dead = deadPid();
    await writeFile(paths.lock, `${String(dead)}\n`);
    const guard = `${paths.lock}.takeover`;
    await writeFile(guard, '');
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(guard, old, old);
    expect(await acquireLock(paths, { pid: 4242, isAlive: (pid) => pid === 4242 })).toEqual({ acquired: true });
    await expect(stat(guard)).rejects.toThrow(/ENOENT/);
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

  it('removeDaemonFiles removes daemon.json, the socket it bound and the lock, tolerating missing ones', async () => {
    await writeDaemonInfo(paths, info);
    await writeFile(paths.lock, '1\n');
    await writeFile(paths.socket, '');
    const bound = await fileIdentity(paths.socket);
    await removeDaemonFiles(paths, bound, 1);
    for (const file of [paths.daemonJson, paths.lock, paths.socket]) await expect(stat(file)).rejects.toThrow(/ENOENT/);
    await removeDaemonFiles(paths, bound, 1);
  });

  it("removeDaemonFiles leaves another daemon's daemon.json, socket and lock alone", async () => {
    await writeFile(paths.socket, '');
    const bound = await fileIdentity(paths.socket);
    // Another daemon replaced the socket file: same path, a different inode.
    await rm(paths.socket);
    await writeFile(join(root, 'filler'), '');
    await writeFile(paths.socket, 'other');
    await writeDaemonInfo(paths, { ...info, pid: 2 });
    await writeFile(paths.lock, '2\n');
    await removeDaemonFiles(paths, bound, 1);
    expect(await readDaemonInfo(paths)).toEqual({ ...info, pid: 2 });
    expect(await readFile(paths.lock, 'utf8')).toBe('2\n');
    expect(await readFile(paths.socket, 'utf8')).toBe('other');
  });

  it('removeDaemonFiles without a bound socket leaves the socket path alone', async () => {
    await writeFile(paths.socket, 'other');
    await removeDaemonFiles(paths, null, 1);
    expect(await readFile(paths.socket, 'utf8')).toBe('other');
  });
});
