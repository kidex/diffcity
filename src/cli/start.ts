// `diffcity start [<dir>] [--port <n>] [--no-open]` (SPEC.md section 3): the one
// command to use. Starts the daemon when needed (the rules of `up`), registers
// the repo at <dir> or the repo containing the cwd with the `track` request,
// prints its URL and opens it. Outside any repo, with no <dir>, it opens the
// Fleet instead.

import { resolve } from 'node:path';
import { identifyRepo } from '../core/changes/identity.js';
import { ensureHome, homePaths, resolveHome, type HomePaths } from '../core/home.js';
import { sendRequest } from '../daemon/client.js';
import { ensureDaemon, parsePort, urlOf, type EnsureDaemonDeps } from './ensure-daemon.js';
import { openBrowser } from './open.js';
import { trackRequest } from './track.js';

export interface StartCommandOptions {
  port?: string;
  /** False with --no-open. */
  open?: boolean;
}

export interface StartDeps extends Omit<EnsureDaemonDeps, 'env'> {
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Opens the URL; resolves false when no browser could be opened. Defaults to openBrowser. */
  openUrl?: (url: string) => Promise<boolean>;
  now?: () => Date;
}

export const OUTSIDE_REPO_HINT = 'not inside a git repository: opening the Fleet; run diffcity start <dir> to open a repo';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the command; resolves with the process exit code (0 or 1). */
export async function runStart(dirArg: string | undefined, options: StartCommandOptions, deps: StartDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity start: ${message}\n`);
    return 1;
  };
  const explicitPort = parsePort(options.port);
  if (explicitPort === null) return fail(`invalid --port: ${String(options.port)}`);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  // Checked before the daemon starts, so a wrong <dir> starts nothing.
  const dir = dirArg === undefined ? cwd : resolve(cwd, dirArg);
  let inRepo = true;
  try {
    await identifyRepo(dir);
  } catch (error) {
    if (dirArg !== undefined) return fail(messageOf(error));
    inRepo = false;
  }

  let paths: HomePaths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    return fail(messageOf(error));
  }

  const ensured = await ensureDaemon({ command: 'start', paths, explicitPort }, { ...deps, env });
  if (ensured.status === 'done') return ensured.code;
  const base = urlOf(ensured.info);

  let url = `${base}/#/`;
  if (inRepo) {
    let response;
    try {
      response = await sendRequest(ensured.info.socket, trackRequest(dir, false, deps.now?.() ?? new Date()));
    } catch (error) {
      return fail(`cannot reach the daemon: ${messageOf(error)}`);
    }
    if (!response.ok) return fail(response.error);
    url = `${base}/#/repo/${String(response.repo.id)}`;
  }

  io.stdout(`${url}\n`);
  if (!inRepo) io.stderr(`${OUTSIDE_REPO_HINT}\n`);
  const openUrl = deps.openUrl ?? ((target: string) => openBrowser(target));
  if (options.open !== false && !(await openUrl(url))) io.stderr(`could not open a browser; open ${url} yourself\n`);
  return 0;
}
