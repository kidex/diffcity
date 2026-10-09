// Spawning real daemons in tests (ADR-015). Every daemon a test starts, through
// the daemon script or through `diffcity up`, lives in a temporary
// DIFFCITY_HOME registered with test/helpers/daemons.ts; DaemonTracker.cleanup()
// (in afterEach) stops every one of them, the setup file sweeps what a file
// registered in afterAll, and the global teardown sweeps the whole run, so no
// test leaves a daemon running.
//
// The same tracker runs short-lived CLI commands (DC-130): their stdin is
// closed unless the test feeds it, `group` puts the child (and anything it
// starts) in its own process group so cleanup and `timeoutMs` kill the whole
// group, and a timed-out run is killed instead of being left to outlive the
// test.

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
  /** True once `timeoutMs` ran out and the run was killed. */
  timedOut(): boolean;
}

export interface SpawnOptions {
  /** Written to stdin, which is then closed. Without it stdin is 'ignore': no child ever waits on an open stdin. */
  input?: string;
  /**
   * Runs the child as the leader of its own process group (detached); cleanup
   * and the timeout then SIGKILL the whole group, grandchildren included.
   */
  group?: boolean;
  /** Kills the run (its group with `group`) after this long; `exited` then resolves with null. */
  timeoutMs?: number;
}

/** True when no process has `pid` (a pid is never reused while a process group with that id exists). */
function pidFree(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * SIGKILLs the child, or its whole process group when it leads one. Once the
 * leader has exited, its group is only signalled while its pid is still free:
 * a taken pid means the group is gone and the id may belong to someone else.
 */
function killRun(child: ChildProcess, group: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  try {
    if (!group) {
      if (!exited) child.kill('SIGKILL');
    } else if (!exited || pidFree(pid)) {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
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
  private readonly children = new Map<ChildProcess, { group: boolean }>();

  /**
   * Runs `node [...nodeArgs] <script> ...args` with `env` (which must carry a
   * temporary DIFFCITY_HOME).
   */
  spawn(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, nodeArgs: string[] = [], options: SpawnOptions = {}): Spawned {
    const home = env[HOME_ENV];
    if (home === undefined) throw new Error('spawned processes need DIFFCITY_HOME in env');
    this.homes.add(home);
    const group = options.group ?? false;
    const child = spawn(process.execPath, [...nodeArgs, script, ...args], {
      env,
      cwd,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: group,
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) throw new Error('spawned without stdout/stderr pipes');
    this.children.set(child, { group });
    registerHome(home, child.pid);
    if (options.input !== undefined) {
      // A child that exits without reading its stdin must not fail the test with EPIPE.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }
    let timedOut = false;
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      killRun(child, group);
    }, options.timeoutMs);
    timer?.unref();
    let out = '';
    let err = '';
    stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    }));
    return { child, stdout: () => out, stderr: () => err, exited, timedOut: () => timedOut };
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

  /**
   * Stops every process running with a home seen (daemons, `up`, `track`),
   * then kills any child still running; a `group` child's whole process group
   * is killed even when the child itself has exited.
   */
  async cleanup(): Promise<void> {
    const pids = [...this.children.keys()].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
    await sweepHomes(this.homes, { pids });
    for (const [child, { group }] of this.children) {
      killRun(child, group);
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
