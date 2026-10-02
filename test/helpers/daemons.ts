// Every daemon a test starts lives in a temporary DIFFCITY_HOME (ADR-015), and
// no test run may leave one running: not when the test passes, fails, times
// out, or when its worker dies. Tests register each temporary home that may
// get a daemon (and the pid of a child when they know it); sweeping a home
// stops every process of this checkout that runs with that home:
//
// - the pids in daemon.json and in the lock, then every process found by its
//   environment (a daemon that has not yet written its lock, a `track` that is
//   about to start one), each confirmed by `ps` before it is signalled;
// - SIGTERM (the whole process group when the process leads its own, as a
//   detached daemon does), then SIGKILL after a short grace;
// - again, until a scan finds nothing, so a daemon started by a `track` that
//   was being stopped is caught too.
//
// A process is only ever signalled when its command line runs a file of this
// checkout and its DIFFCITY_HOME is a registered home or lies under one: a
// daemon of the real ~/.config/diffcity, or of another checkout, is never
// touched. Homes with whitespace in their path are not supported (macOS `ps
// -E` separates variables with spaces).
//
// The global setups of vitest and Playwright create a registry file for the
// run (REGISTRY_ENV); every registration is appended to it, and their
// teardowns sweep every home in it, so a worker that died still gets its
// daemons stopped. This module imports neither vitest nor Playwright.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { homePaths } from '../../src/core/home.js';

/** The run's registry file; set by the global setups, inherited by the workers. */
export const REGISTRY_ENV = 'DIFFCITY_TEST_DAEMON_REGISTRY';
/** Where the registry files of all runs live (not `dc-*`, so they never look like a home). */
export const REGISTRY_DIR = join(tmpdir(), 'diffcity-test-runs');

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** Command lines that run a file of this checkout (dist/ or a test fixture). */
const OWN_PREFIXES = [join(repoRoot, 'dist') + '/', join(repoRoot, 'test') + '/'];

/** Grace between SIGTERM and SIGKILL. */
const TERM_GRACE_MS = 3000;
/** How long to wait for SIGKILLed processes to disappear. */
const KILL_WAIT_MS = 2000;
/** Rounds of scan-and-stop before giving up (a round finding nothing ends the sweep). */
const MAX_ROUNDS = 6;

const registered = new Set<string>();
const registeredPids = new Set<number>();

/** `path` and, when it differs and can be resolved, its real path (or its parent's, for a home not yet created). */
function spellings(path: string): string[] {
  const out = new Set([path]);
  for (const resolve of [() => realpathSync(path), () => join(realpathSync(dirname(path)), basename(path))]) {
    try {
      out.add(resolve());
      break;
    } catch {
      // Not there (yet): try the parent.
    }
  }
  return [...out];
}

/** Prefix of the temporary roots the test helpers create (`dc-XXXXXX`). */
const TEMP_ROOT_PREFIX = 'dc-';

/** `path` with its real path resolved as far as it exists (a home not yet created resolves through its parent). */
function resolved(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Throws unless `home` lies under os.tmpdir() (real paths, so macOS /var is
 * /private/var) inside a root whose name starts with `dc-`. The sweep signals
 * processes by home, so a registered real home would be fatal.
 */
function assertTempHome(home: string): void {
  const rel = relative(resolved(tmpdir()), resolved(home));
  const [root] = rel.split(sep);
  if (rel === '' || rel.startsWith('..') || root === undefined || !root.startsWith(TEMP_ROOT_PREFIX)) {
    throw new Error(`registerHome: ${home} is not under a ${TEMP_ROOT_PREFIX}* directory of os.tmpdir(); refusing to register it`);
  }
}

/**
 * Registers a temporary home (or a directory holding homes) whose daemons must
 * be stopped, and the pid of a child that may run one. Recorded in this
 * process and in the run's registry file. Throws for a path that is not a
 * `dc-*` temporary directory (or below one) of os.tmpdir().
 */
export function registerHome(home: string, pid?: number): void {
  assertTempHome(home);
  for (const spelling of spellings(home)) registered.add(spelling);
  if (pid !== undefined) registeredPids.add(pid);
  const file = process.env[REGISTRY_ENV];
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, `${JSON.stringify({ home, ...(pid === undefined ? {} : { pid }) })}\n`);
  } catch {
    // The registry went away (the run is ending); this process still sweeps its own.
  }
}

/** The homes and pids registered in this process. */
export function registeredHere(): { homes: string[]; pids: number[] } {
  return { homes: [...registered], pids: [...registeredPids] };
}

/** Forgets what this process registered (after a sweep). */
export function forgetRegistered(): void {
  registered.clear();
  registeredPids.clear();
}

// ---------------------------------------------------------------------------
// Finding processes

export interface HomeProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
  /** Its DIFFCITY_HOME. */
  readonly home: string;
}

interface PsLine {
  pid: number;
  pgid: number;
  command: string;
}

function psAll(): PsLine[] {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ps.status !== 0) return [];
  const lines: PsLine[] = [];
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    lines.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] ?? '' });
  }
  return lines;
}

/** DIFFCITY_HOME of each pid, read from its environment; pids whose environment cannot be read are left out. */
function homesOf(pids: readonly number[]): Map<number, string> {
  const homes = new Map<number, string>();
  if (pids.length === 0) return homes;
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        const environ = readFileSync(`/proc/${String(pid)}/environ`, 'utf8').split('\0');
        const entry = environ.find((variable) => variable.startsWith('DIFFCITY_HOME='));
        if (entry !== undefined) homes.set(pid, entry.slice('DIFFCITY_HOME='.length));
      } catch {
        // Gone, or not ours.
      }
    }
    return homes;
  }
  // macOS (and the BSDs): `ps -E` appends the environment to the command line.
  const ps = spawnSync('ps', ['-E', '-ww', '-o', 'pid=,args=', '-p', pids.join(',')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const line of ps.stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match === null) continue;
    const home = /(?:^|\s)DIFFCITY_HOME=(\S+)/.exec(match[2] ?? '')?.[1];
    if (home !== undefined) homes.set(Number(match[1]), home);
  }
  return homes;
}

/** True when `home` is one of `roots` or lies below one of them. */
function isUnder(home: string, roots: readonly string[]): boolean {
  return roots.some((root) => home === root || home.startsWith(root.endsWith('/') ? root : `${root}/`));
}

/**
 * The processes of this checkout running with a DIFFCITY_HOME equal to, or
 * below, one of `homes`. Only these may ever be signalled.
 */
export function findHomeProcesses(homes: Iterable<string>): HomeProcess[] {
  const roots = [...new Set([...homes].flatMap(spellings))];
  if (roots.length === 0) return [];
  const own = psAll().filter((line) => line.pid !== process.pid && OWN_PREFIXES.some((prefix) => line.command.includes(prefix)));
  const envHomes = homesOf(own.map((line) => line.pid));
  const found: HomeProcess[] = [];
  for (const line of own) {
    const home = envHomes.get(line.pid);
    if (home !== undefined && isUnder(home, roots)) found.push({ ...line, home });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Stopping them

/** The pids daemon.json and the lock of `home` name; hints only, confirmed by findHomeProcesses. */
function filePids(home: string): number[] {
  const paths = homePaths(home);
  const pids: number[] = [];
  try {
    const info = JSON.parse(readFileSync(paths.daemonJson, 'utf8')) as { pid?: unknown };
    if (typeof info.pid === 'number') pids.push(info.pid);
  } catch {
    // No daemon.json.
  }
  try {
    const lockPid = Number(readFileSync(paths.lock, 'utf8').trim());
    if (Number.isSafeInteger(lockPid) && lockPid > 0) pids.push(lockPid);
  } catch {
    // No lock.
  }
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signals the process, or its whole group when it leads one (a detached daemon and its git children). */
function signal(target: HomeProcess, sig: NodeJS.Signals): void {
  try {
    if (target.pgid === target.pid && target.pgid !== process.pid) process.kill(-target.pgid, sig);
    else process.kill(target.pid, sig);
  } catch {
    // Already gone.
  }
}

async function waitGone(pids: readonly number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(25);
    left = left.filter(alive);
  }
  return left;
}

export interface SweepOptions {
  /** Pids known to the caller (children it spawned); stopped only if they run with one of the homes. */
  pids?: Iterable<number>;
  graceMs?: number;
}

/**
 * Stops every process of this checkout whose DIFFCITY_HOME is one of `homes`
 * (or below one): SIGTERM, then SIGKILL after the grace, until a scan finds
 * none. Resolves with the pids it signalled.
 */
export async function sweepHomes(homes: Iterable<string>, options: SweepOptions = {}): Promise<number[]> {
  const list = [...homes];
  if (list.length === 0) return [];
  const signalled = new Set<number>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const found = findHomeProcesses(list);
    if (found.length === 0) break;
    // daemon.json first, then the lock, then the caller's pids, then the rest.
    const hinted = [...list.flatMap(filePids), ...(options.pids ?? [])];
    const rank = (pid: number): number => {
      const index = hinted.indexOf(pid);
      return index === -1 ? hinted.length : index;
    };
    const ordered = [...found].sort((a, b) => rank(a.pid) - rank(b.pid));
    for (const target of ordered) {
      signalled.add(target.pid);
      signal(target, 'SIGTERM');
    }
    const stubborn = await waitGone(ordered.map((target) => target.pid), options.graceMs ?? TERM_GRACE_MS);
    for (const target of ordered.filter((candidate) => stubborn.includes(candidate.pid))) signal(target, 'SIGKILL');
    await waitGone(stubborn, KILL_WAIT_MS);
  }
  return [...signalled];
}

// ---------------------------------------------------------------------------
// The run registry

interface RegistryHeader {
  checkout: string;
  owner: number;
}

/**
 * Creates the registry file of this run and points REGISTRY_ENV at it (the
 * workers inherit it). Reuses the one already set in this process.
 */
export function createRunRegistry(): string {
  const existing = process.env[REGISTRY_ENV];
  if (existing !== undefined && existing !== '') return existing;
  mkdirSync(REGISTRY_DIR, { recursive: true });
  const file = join(REGISTRY_DIR, `run-${String(process.pid)}-${String(Date.now())}.jsonl`);
  const header: RegistryHeader = { checkout: repoRoot, owner: process.pid };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  process.env[REGISTRY_ENV] = file;
  return file;
}

function readRegistry(file: string): { header: RegistryHeader | null; homes: string[]; pids: number[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { header: null, homes: [], pids: [] };
  }
  const [first, ...rest] = text.split('\n');
  let header: RegistryHeader | null = null;
  try {
    header = JSON.parse(first ?? '') as RegistryHeader;
  } catch {
    // A broken header: the file is not one of ours.
  }
  const homes = new Set<string>();
  const pids = new Set<number>();
  for (const line of rest) {
    if (line === '') continue;
    try {
      const entry = JSON.parse(line) as { home?: unknown; pid?: unknown };
      if (typeof entry.home === 'string' && entry.home !== '') homes.add(entry.home);
      if (typeof entry.pid === 'number') pids.add(entry.pid);
    } catch {
      // A line cut short by a dying worker.
    }
  }
  return { header, homes: [...homes], pids: [...pids] };
}

/** Sweeps every home in the registry file, then removes it. Resolves with the pids signalled. */
export async function sweepRunRegistry(file: string): Promise<number[]> {
  const { homes, pids } = readRegistry(file);
  const signalled = await sweepHomes(homes, { pids });
  rmSync(file, { force: true });
  if (process.env[REGISTRY_ENV] === file) Reflect.deleteProperty(process.env, REGISTRY_ENV);
  return signalled;
}

/**
 * Sweeps the registries left by earlier runs of this checkout whose owner is
 * gone (a run killed before its teardown). Registries of other checkouts, and
 * of runs still going, are left alone.
 */
export async function sweepStaleRegistries(): Promise<number[]> {
  let names: string[];
  try {
    names = readdirSync(REGISTRY_DIR);
  } catch {
    return [];
  }
  const signalled: number[] = [];
  for (const name of names) {
    if (!/^run-\d+-\d+\.jsonl$/.test(name)) continue;
    const file = join(REGISTRY_DIR, name);
    const { header } = readRegistry(file);
    if (header === null || header.checkout !== repoRoot || header.owner === process.pid || alive(header.owner)) continue;
    signalled.push(...(await sweepRunRegistry(file)));
  }
  return signalled;
}
