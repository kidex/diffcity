// Spawning real daemons in tests (ADR-015). Every daemon a test starts, through
// the daemon script or through `diffcity up`, lives in a temporary
// DIFFCITY_HOME; DaemonTracker.cleanup() (in afterEach) stops every one of
// them, so no test leaves a daemon running.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { homePaths, HOME_ENV } from '../../src/core/home.js';
import { sendRequest } from '../../src/daemon/client.js';
import { isProcessAlive, readDaemonInfo } from '../../src/daemon/files.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Built by test/global-setup.ts. */
export const DAEMON_MAIN_DIST = join(repoRoot, 'dist', 'daemon', 'main.js');
export const CLI_DIST = join(repoRoot, 'dist', 'cli', 'index.js');

export interface Spawned {
  readonly child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves with the exit code (null when killed by a signal). */
  readonly exited: Promise<number | null>;
}

/** Polls `check` until it returns a value other than undefined/false, or throws after `timeoutMs`. */
export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await sleep(25);
  }
}

export class DaemonTracker {
  private readonly homes = new Set<string>();
  private readonly children = new Set<ChildProcess>();

  /** Runs `node <script> ...args` with `env` (which must carry a temporary DIFFCITY_HOME). */
  spawn(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Spawned {
    const home = env[HOME_ENV];
    if (home === undefined) throw new Error('spawned processes need DIFFCITY_HOME in env');
    this.homes.add(home);
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => {
      resolve(code);
    }));
    return { child, stdout: () => out, stderr: () => err, exited };
  }

  /** The daemon script with `--port 0` unless other args are given. */
  spawnDaemon(env: NodeJS.ProcessEnv, args: string[] = ['--port', '0']): Spawned {
    return this.spawn(DAEMON_MAIN_DIST, args, env);
  }

  /** The built CLI. */
  cli(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Spawned {
    return this.spawn(CLI_DIST, args, env, cwd);
  }

  /** Registers a home whose daemon must be stopped on cleanup (one started by `up`, say). */
  track(home: string): void {
    this.homes.add(home);
  }

  /** Stops every daemon in every home seen, then kills any child still running. */
  async cleanup(): Promise<void> {
    for (const home of this.homes) await stopDaemonIn(home);
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    this.homes.clear();
    this.children.clear();
  }
}

/** The pids that may belong to a daemon of this home: daemon.json and the lock. */
async function daemonPids(home: string): Promise<number[]> {
  const paths = homePaths(home);
  const pids = new Set<number>();
  const info = await readDaemonInfo(paths).catch(() => null);
  if (info !== null) pids.add(info.pid);
  const lock = await readFile(paths.lock, 'utf8').catch(() => '');
  const lockPid = Number(lock.trim());
  if (Number.isSafeInteger(lockPid) && lockPid > 0) pids.add(lockPid);
  return [...pids].filter((pid) => pid !== process.pid);
}

/**
 * True when `pid` runs this checkout's daemon script. A pid read from a stale
 * lock may since belong to an unrelated process, which must never be killed.
 */
function isOurDaemon(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(DAEMON_MAIN_DIST);
}

/** Sends `shutdown`, waits up to 5 s for the daemons to exit, then SIGKILLs those still running. */
export async function stopDaemonIn(home: string): Promise<void> {
  const paths = homePaths(home);
  const pids = (await daemonPids(home)).filter(isOurDaemon);
  const info = await readDaemonInfo(paths).catch(() => null);
  if (info !== null) await sendRequest(info.socket, { v: 1, type: 'shutdown' }, { timeoutMs: 2000 }).catch(() => undefined);
  const deadline = Date.now() + 5000;
  const running = (): number[] => pids.filter((pid) => isProcessAlive(pid) && isOurDaemon(pid));
  while (running().length > 0 && Date.now() < deadline) await sleep(25);
  for (const pid of running()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** An open SSE connection; `until` reads until the text so far contains `marker`. */
export interface SseConnection {
  readonly contentType: string | null;
  until(marker: string): Promise<string>;
  close(): void;
}

export async function openSse(port: number): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, { signal: controller.signal });
  if (response.body === null) throw new Error('SSE response without a body');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    contentType: response.headers.get('content-type'),
    async until(marker) {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`SSE stream ended before ${JSON.stringify(marker)}`);
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
    close: () => {
      controller.abort();
    },
  };
}
