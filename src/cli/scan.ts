// `diffcity scan <dir>` (SPEC.md section 3, ADR-016): finds the repos under a
// folder with discoverRepos and registers them with the daemon in `register`
// requests, starting the daemon if needed. What the daemon does with them
// (inactive, collected once) is ADR-020's business.

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureHome, homePaths, resolveHome } from '../core/home.js';
import { discoverRepos } from '../core/repos/discover.js';
import { requestWithAutostart, type SpawnDaemonOptions, type SpawnedDaemon } from '../daemon/client.js';
import { MAX_REQUEST_BYTES } from '../daemon/socket/protocol.js';

export interface ScanDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
  spawnDaemon?: (options: SpawnDaemonOptions) => SpawnedDaemon;
  startTimeoutMs?: number;
  /** Longest request line; defaults to the protocol's MAX_REQUEST_BYTES. */
  maxRequestBytes?: number;
}

const requestBytes = (dirs: string[]): number => Buffer.byteLength(JSON.stringify({ v: 1, type: 'register', dirs }), 'utf8');

/**
 * Splits `dirs` into consecutive batches whose register request line fits in
 * `maxBytes`. A root too long to fit on its own still gets a batch: the daemon
 * then refuses it with a message instead of the CLI dropping it silently.
 */
export function registerBatches(dirs: string[], maxBytes: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const dir of dirs) {
    if (current.length > 0 && requestBytes([...current, dir]) > maxBytes) {
      batches.push(current);
      current = [];
    }
    current.push(dir);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const repos = (count: number): string => `${String(count)} ${count === 1 ? 'repo' : 'repos'}`;

/** Runs the command; resolves with the process exit code (0 or 1). */
export async function runScan(dirArg: string, deps: ScanDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity scan: ${message}\n`);
    return 1;
  };
  const dir = resolve(deps.cwd ?? process.cwd(), dirArg);

  let roots: string[];
  try {
    if (!(await stat(dir)).isDirectory()) return fail(`not a directory: ${dir}`);
    roots = await discoverRepos(dir);
  } catch (error) {
    return fail(`cannot scan ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (roots.length === 0) {
    io.stdout(`no repos found under ${dir}\n`);
    return 0;
  }

  const env = deps.env ?? process.env;
  let paths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  let registered = 0;
  let known = 0;
  for (const dirs of registerBatches(roots, deps.maxRequestBytes ?? MAX_REQUEST_BYTES)) {
    const result = await requestWithAutostart(
      paths,
      { v: 1, type: 'register', dirs },
      {
        env,
        ...(deps.spawnDaemon === undefined ? {} : { spawn: deps.spawnDaemon }),
        ...(deps.startTimeoutMs === undefined ? {} : { timeoutMs: deps.startTimeoutMs }),
      },
    );
    const response = result.ok ? result.response : { ok: false as const, error: result.error };
    if (!response.ok) {
      // Earlier batches are registered already: say so before the error.
      if (registered + known > 0) io.stdout(`registered ${repos(registered)} (${String(known)} already known) before the error\n`);
      return fail(response.error);
    }
    registered += response.registered;
    known += response.known;
  }
  io.stdout(`registered ${repos(registered)} (${String(known)} already known)\n`);
  return 0;
}
