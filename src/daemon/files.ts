// The files the daemon keeps in DIFFCITY_HOME (ADR-015): the single-instance
// lock, daemon.json (the "ready" signal) and state.json (the last `up --port`).
// The CLI reads them too, through this module.

import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HomePaths } from '../core/home.js';
import type { DaemonInfo, DaemonState } from '../core/model/types.js';

/** The port used when neither `--port` nor state.json gives one. */
export const DEFAULT_PORT = 4321;

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { acquired: true } | { acquired: false; owner: number };

export interface AcquireLockOptions {
  pid: number;
  isAlive?: (pid: number) => boolean;
  /**
   * How long a lock without a valid pid is given to get one: a competing daemon
   * creates the file and writes its pid in two steps. Defaults to 500 ms.
   */
  unreadableGraceMs?: number;
}

function parsePid(text: string): number | null {
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function readLockPid(path: string): Promise<number | null | 'missing'> {
  try {
    return parsePid(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function createLock(path: string, pid: number): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(`${String(pid)}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Takes the single-instance lock: `daemon.lock` created with `wx`, holding our
 * pid. When it exists and its pid is alive, the lock is not ours and the owner
 * is returned. When the pid is dead (or the file never gets a valid pid), the
 * lock is stale: the lock and the socket are removed and the lock is tried once
 * more. A lost second try reports the new owner.
 */
export async function acquireLock(paths: HomePaths, options: AcquireLockOptions): Promise<LockResult> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const graceMs = options.unreadableGraceMs ?? 500;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createLock(paths.lock, options.pid)) return { acquired: true };

    let owner = await readLockPid(paths.lock);
    const deadline = Date.now() + graceMs;
    while (owner === null && Date.now() < deadline) {
      await sleep(10);
      owner = await readLockPid(paths.lock);
    }
    if (owner === 'missing') continue;
    if (owner !== null && isAlive(owner)) return { acquired: false, owner };
    if (attempt === 1) break;
    await rm(paths.lock, { force: true });
    await rm(paths.socket, { force: true });
  }

  const owner = await readLockPid(paths.lock);
  return { acquired: false, owner: typeof owner === 'number' ? owner : 0 };
}

/** Removes the lock if it still holds `pid`. */
export async function releaseLock(paths: HomePaths, pid: number): Promise<void> {
  const owner = await readLockPid(paths.lock);
  if (owner === pid) await rm(paths.lock, { force: true });
}

/** Writes JSON through a temporary file and a rename, so a reader never sees half a file. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A TCP port number; 0 means "any free port". */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
}

export async function writeDaemonInfo(paths: HomePaths, info: DaemonInfo): Promise<void> {
  await writeJsonAtomic(paths.daemonJson, info);
}

/** daemon.json, or null when it is missing or not a valid DaemonInfo. */
export async function readDaemonInfo(paths: HomePaths): Promise<DaemonInfo | null> {
  const value = await readJson(paths.daemonJson);
  if (!isRecord(value)) return null;
  const { pid, port, socket, version, startedAt } = value;
  if (typeof pid !== 'number' || !isPort(port) || typeof socket !== 'string') return null;
  if (typeof version !== 'string' || typeof startedAt !== 'string') return null;
  return { pid, port, socket, version, startedAt };
}

export async function writeState(paths: HomePaths, state: DaemonState): Promise<void> {
  await writeJsonAtomic(paths.state, state);
}

/** state.json, or null when it is missing or invalid. */
export async function readState(paths: HomePaths): Promise<DaemonState | null> {
  const value = await readJson(paths.state);
  if (!isRecord(value) || !isPort(value.port) || value.port === 0) return null;
  return { port: value.port };
}

/** The port to listen on: the explicit one, else state.json, else DEFAULT_PORT. */
export async function resolvePort(paths: HomePaths, explicit: number | undefined): Promise<number> {
  if (explicit !== undefined) return explicit;
  return (await readState(paths))?.port ?? DEFAULT_PORT;
}

/**
 * Shutdown cleanup (ADR-015), in order: daemon.json, the socket, then the lock.
 * daemon.json and the lock are removed only while they still belong to `pid`.
 */
export async function removeDaemonFiles(paths: HomePaths, socket: string, pid: number): Promise<void> {
  const info = await readDaemonInfo(paths);
  if (info === null || info.pid === pid) await rm(paths.daemonJson, { force: true });
  await rm(socket, { force: true });
  await releaseLock(paths, pid);
}
