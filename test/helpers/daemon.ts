// Spawning real daemons in tests (ADR-015). Every daemon a test starts, through
// the daemon script or through `diffcity up`, lives in a temporary
// DIFFCITY_HOME registered with test/helpers/daemons.ts; DaemonTracker.cleanup()
// (in afterEach) stops every one of them, the setup file sweeps what a file
// registered in afterAll, and the global teardown sweeps the whole run, so no
// test leaves a daemon running.

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HOME_ENV } from '../../src/core/home.js';
import { registerHome, sweepHomes } from './daemons.js';

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
export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 45_000, what = 'condition'): Promise<T> {
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

  /**
   * Runs `node [...nodeArgs] <script> ...args` with `env` (which must carry a
   * temporary DIFFCITY_HOME).
   */
  spawn(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, nodeArgs: string[] = []): Spawned {
    const home = env[HOME_ENV];
    if (home === undefined) throw new Error('spawned processes need DIFFCITY_HOME in env');
    this.homes.add(home);
    const child = spawn(process.execPath, [...nodeArgs, script, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    registerHome(home, child.pid);
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
    registerHome(home);
  }

  /** Stops every process running with a home seen (daemons, `up`, `track`), then kills any child still running. */
  async cleanup(): Promise<void> {
    const pids = [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
    await sweepHomes(this.homes, { pids });
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    this.homes.clear();
    this.children.clear();
  }
}

/**
 * Stops every process of this checkout running with `home` as its
 * DIFFCITY_HOME (see test/helpers/daemons.ts): SIGTERM, then SIGKILL.
 */
export async function stopDaemonIn(home: string): Promise<void> {
  registerHome(home);
  await sweepHomes([home]);
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
