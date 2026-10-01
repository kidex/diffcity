// daemon/up-after-sigkill (ADR-015, ADR-016): a daemon killed with SIGKILL
// leaves daemon.json, the lock and its socket file behind, and a start that
// was killed while binding leaves a temporary `.dcXXXXXX` socket name. The
// next `diffcity up` recovers all of it: a new daemon owns the lock, rewrites
// daemon.json, rebinds the socket and sweeps the temporary name.

import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths, type HomePaths } from '../../../src/core/home.js';
import type { DaemonInfo } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { isProcessAlive, readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';

let temp: TempHome;
let paths: HomePaths;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  daemons.track(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});

async function up(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = daemons.cli(['up', '--port', '0', '--no-open'], temp.env, temp.userHome);
  const code = await run.exited;
  return { code, stdout: run.stdout(), stderr: run.stderr() };
}

async function daemonInfo(): Promise<DaemonInfo> {
  const info = await readDaemonInfo(paths);
  if (info === null) throw new Error('no daemon.json');
  return info;
}

const isSocket = (file: string): Promise<boolean> =>
  stat(file).then(
    (stats) => stats.isSocket(),
    () => false,
  );

/**
 * Leaves a socket file at `path` that nobody listens on, as a start killed
 * between bind and rename would: a child binds it and is SIGKILLed, so Node
 * never unlinks it.
 */
async function abandonedSocket(path: string): Promise<void> {
  const script = `require('node:net').createServer().listen(${JSON.stringify(path)}, () => process.stdout.write('bound'));`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => {
      resolve();
    });
    child.once('exit', (code) => {
      reject(new Error(`socket holder exited with ${String(code)}`));
    });
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

describe('diffcity up after SIGKILL', () => {
  it('daemon/up-after-sigkill: recovers the stale lock, daemon.json, the socket and a leftover temporary socket name', async () => {
    const first = await up();
    expect(first.code).toBe(0);
    const killed = await daemonInfo();
    // The temporary home is short, so the socket lives in it.
    expect(killed.socket).toBe(paths.socket);

    process.kill(killed.pid, 'SIGKILL');
    await waitFor(() => !isProcessAlive(killed.pid), 5_000, 'the killed daemon to exit');
    // SIGKILL ran no cleanup: everything is still there.
    expect(await readFile(paths.lock, 'utf8')).toBe(`${String(killed.pid)}\n`);
    expect((await daemonInfo()).pid).toBe(killed.pid);
    expect(await isSocket(killed.socket)).toBe(true);

    const leftover = join(dirname(killed.socket), '.dc0a1b2c');
    await abandonedSocket(leftover);
    expect(await isSocket(leftover)).toBe(true);

    const second = await up();
    expect(second.stderr).toBe('');
    expect(second.code).toBe(0);
    const info = await daemonInfo();
    expect(info.pid).not.toBe(killed.pid);
    expect(isProcessAlive(info.pid)).toBe(true);
    expect(second.stdout).toBe(`http://127.0.0.1:${String(info.port)}\n`);
    expect(await readFile(paths.lock, 'utf8')).toBe(`${String(info.pid)}\n`);
    expect(await sendRequest(info.socket, { v: 1, type: 'ping' })).toEqual({ ok: true, version: info.version, pid: info.pid, port: info.port });
    expect((await stat(info.socket)).mode & 0o777).toBe(0o600);
    expect((await fetch(`http://127.0.0.1:${String(info.port)}/api/health`)).status).toBe(200);

    // No temporary socket name survives: neither the planted one nor the new daemon's own.
    const names = await readdir(dirname(info.socket));
    expect(names.filter((name) => /^\.dc[0-9a-f]{6}$/.test(name))).toEqual([]);
  });
});
