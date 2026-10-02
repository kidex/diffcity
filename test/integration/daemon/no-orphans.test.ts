// DC-58: no test run leaves a daemon running. A test that times out after
// starting a detached daemon gets it stopped by its afterEach, found through
// its DIFFCITY_HOME even before it wrote daemon.json or the lock; a worker that
// died before its cleanup gets its daemons stopped by the global teardown,
// which sweeps the homes in the run's registry file. A daemon whose home is not
// registered is never touched.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureHome, homePaths } from '../../../src/core/home.js';
import { spawnDaemon } from '../../../src/daemon/client.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DAEMON_MAIN_DIST, DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { findHomeProcesses, REGISTRY_DIR, REGISTRY_ENV, sweepRunRegistry, sweepStaleRegistries } from '../../helpers/daemons.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts the built daemon detached, as `up` and `track` do; resolves with its pid. */
async function detachedDaemon(temp: TempHome): Promise<number> {
  const paths = homePaths(temp.home);
  await ensureHome(paths.home);
  const { pid } = spawnDaemon({ paths, env: temp.env, port: 0, main: DAEMON_MAIN_DIST });
  if (pid === undefined) throw new Error('the daemon did not spawn');
  return pid;
}

const ready = (temp: TempHome): Promise<true> =>
  waitFor(() => existsSync(homePaths(temp.home).daemonJson), 30_000, 'daemon.json');

describe('a test that times out after starting a daemon', () => {
  const daemons = new DaemonTracker();
  let temp: TempHome;
  let pid: number | undefined;

  beforeAll(async () => {
    temp = await tempHome();
  });
  afterEach(async () => {
    await daemons.cleanup();
  });
  afterAll(async () => {
    await temp.cleanup();
  });

  // The timeout is the point: `fails` turns it into a pass, and afterEach still runs.
  it.fails('orphans/timeout-starts-daemon: starts a detached daemon, registers only its home, then hangs past its timeout', { timeout: 50 }, async () => {
    daemons.track(temp.home);
    pid = await detachedDaemon(temp);
    await new Promise(() => undefined);
  });

  it('orphans/timeout-no-process-left: afterEach stopped it, so no process runs with that home', () => {
    expect(pid).toBeTypeOf('number');
    expect(alive(pid ?? 0)).toBe(false);
    expect(findHomeProcesses([temp.home])).toEqual([]);
  });
});

describe('the global teardown, after a worker died', () => {
  const daemons = new DaemonTracker();
  const temps: TempHome[] = [];
  const registries: string[] = [];

  afterEach(async () => {
    await daemons.cleanup();
    for (const temp of temps.splice(0)) await temp.cleanup();
    for (const file of registries.splice(0)) await rm(file, { force: true });
  });

  async function newTemp(): Promise<TempHome> {
    const temp = await tempHome();
    temps.push(temp);
    // Stopped by afterEach if an assertion fails; the sweeps under test only read the registry files.
    daemons.track(temp.home);
    return temp;
  }

  /** A registry file as a run whose owner is `owner` leaves it: the header, then one line per home. */
  async function registryFile(owner: number, homes: string[]): Promise<string> {
    const file = join(REGISTRY_DIR, `run-${String(owner)}-${String(Date.now())}.jsonl`);
    registries.push(file);
    const lines = [{ checkout: repoRoot, owner }, ...homes.map((home) => ({ home }))].map((line) => JSON.stringify(line));
    await writeFile(file, `${lines.join('\n')}\n`);
    return file;
  }

  it('orphans/worker-sees-registry: the workers inherit the run registry from the global setup', () => {
    const file = process.env[REGISTRY_ENV];
    expect(file).toBeTypeOf('string');
    expect(existsSync(file ?? '')).toBe(true);
  });

  it('orphans/teardown-sweeps-registry: the daemon of a registered home is stopped, an unregistered one keeps running', async () => {
    const orphanHome = await newTemp();
    const bystanderHome = await newTemp();
    const orphan = await detachedDaemon(orphanHome);
    const bystander = await detachedDaemon(bystanderHome);
    await ready(orphanHome);
    await ready(bystanderHome);
    const file = await registryFile(process.pid, [orphanHome.home]);

    const signalled = await sweepRunRegistry(file);

    expect(signalled).toContain(orphan);
    expect(signalled).not.toContain(bystander);
    expect(alive(orphan)).toBe(false);
    expect(findHomeProcesses([orphanHome.home])).toEqual([]);
    expect(alive(bystander)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('orphans/stale-registry: a registry whose run is gone is swept at the next start; one whose owner lives is left alone', async () => {
    const deadOwner = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    const staleHome = await newTemp();
    const liveHome = await newTemp();
    const stale = await detachedDaemon(staleHome);
    const live = await detachedDaemon(liveHome);
    await ready(staleHome);
    await ready(liveHome);
    const staleFile = await registryFile(deadOwner, [staleHome.home]);
    // This worker is alive: its registry belongs to a run still going.
    const liveFile = await registryFile(process.ppid, [liveHome.home]);

    const signalled = await sweepStaleRegistries();

    expect(signalled).toContain(stale);
    expect(alive(stale)).toBe(false);
    expect(existsSync(staleFile)).toBe(false);
    expect(alive(live)).toBe(true);
    expect(existsSync(liveFile)).toBe(true);
  });
});
