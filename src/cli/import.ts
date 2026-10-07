// `diffcity import <findings.json|*.sarif.json> [--open]` (SPEC.md sections 3
// and 5.6, ADR-036). Reads the file (at most 8 MiB), parses it in src/core
// (own format or SARIF 2.1), and sends the findings over the socket for the
// change checked out in the current directory; the daemon anchors and stores
// them. Starts the daemon when none runs, with the rules of `start`.
//
// The module stays light: it loads the findings parsers (pure JSON code), the
// socket client and the git root probe, never the code parser (web-tree-sitter,
// ts-morph) nor src/core/report or src/core/parse.
// test/integration/cli/track-lazy-imports guards that.

import { open as openFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_FINDINGS_FILE_BYTES, parseFindingsText } from '../core/findings/file.js';
import { findRepoRoot } from '../core/git/change.js';
import { rootSpellings } from '../core/git/root.js';
import { ensureHome, homePaths, resolveHome, type HomePaths } from '../core/home.js';
import type { SocketRequest, SocketSuccessResponses } from '../core/model/types.js';
import { sendRequest } from '../daemon/client.js';
import { IMPORT_REQUEST_TIMEOUT_MS, MAX_IMPORT_REQUEST_BYTES, MAX_REQUEST_BYTES } from '../daemon/socket/protocol.js';
import { ensureDaemon, urlOf, type EnsureDaemonDeps } from './ensure-daemon.js';
import { openBrowser } from './open.js';

export interface ImportCommandOptions {
  open?: boolean;
}

export interface ImportDeps extends Omit<EnsureDaemonDeps, 'env'> {
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Opens the URL; resolves false when no browser could be opened. Defaults to openBrowser. */
  openUrl?: (url: string) => Promise<boolean>;
  now?: () => Date;
  /** The wait for the daemon's answer; defaults to IMPORT_CLIENT_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/** The CLI waits a little longer than the daemon's own timeout for an import exchange. */
export const IMPORT_CLIENT_TIMEOUT_MS = IMPORT_REQUEST_TIMEOUT_MS + 5000;

/** Printed when the running daemon does not know the `import` request. */
export const OLD_DAEMON_MESSAGE = 'the running daemon is older than this CLI; run `diffcity stop` then try again';

const MIB = 1024 * 1024;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The errors a daemon from before `import` gives for one. */
function isOldDaemonError(error: string): boolean {
  return (
    error.startsWith('unknown request type: import') ||
    error === 'import is not supported by this daemon yet' ||
    // An older daemon reads 64 KiB at most, whatever the type.
    error === `request exceeds ${String(MAX_REQUEST_BYTES)} bytes`
  );
}

/** How the summary names a change: the branch, `PR #n`, or the Draft. */
export function changeLabel(ref: string): string {
  if (ref.startsWith('branch:')) return ref.slice('branch:'.length);
  if (ref.startsWith('pr:')) return `PR #${ref.slice('pr:'.length)}`;
  if (ref.startsWith('draft:')) {
    const path = ref.slice('draft:'.length);
    return path === '' ? 'the Draft' : `the Draft in ${path}`;
  }
  return ref;
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** "Imported 7 findings into feature/cart (2 merged, 1 skipped, 3 fixed)". */
export function importSummary(reply: SocketSuccessResponses['import']): string {
  return `Imported ${plural(reply.imported, 'finding')} into ${changeLabel(reply.change.ref)} (${String(reply.merged)} merged, ${String(reply.skipped)} skipped, ${String(reply.fixed)} fixed)`;
}

/** Reads at most MAX_FINDINGS_FILE_BYTES; a larger file is refused before it is read. */
async function readFindingsFile(path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let handle;
  try {
    handle = await openFile(path, 'r');
  } catch (error) {
    return { ok: false, error: `cannot read ${path}: ${messageOf(error)}` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: `${path} is not a file` };
    if (info.size > MAX_FINDINGS_FILE_BYTES) {
      return { ok: false, error: `${path} is ${String(info.size)} bytes; a findings file may be at most ${String(MAX_FINDINGS_FILE_BYTES / MIB)} MiB` };
    }
    const bytes = Buffer.alloc(MAX_FINDINGS_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    // Grown since the stat: still refused.
    if (bytesRead > MAX_FINDINGS_FILE_BYTES) return { ok: false, error: `${path} is over ${String(MAX_FINDINGS_FILE_BYTES / MIB)} MiB` };
    return { ok: true, text: bytes.subarray(0, bytesRead).toString('utf8') };
  } finally {
    await handle.close();
  }
}

/** Runs the command; resolves with the process exit code (0 or 1). */
export async function runImport(fileArg: string, options: ImportCommandOptions, deps: ImportDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity import: ${message}\n`);
    return 1;
  };
  const env = deps.env ?? process.env;
  const cwd = resolve(deps.cwd ?? process.cwd());
  const file = resolve(cwd, fileArg);

  // Checked first, so outside a repo nothing is read and no daemon starts.
  let roots: string[];
  try {
    // Absolute paths in the file may use the root as git spells it or as the shell reached it.
    roots = await rootSpellings(await findRepoRoot(cwd), [cwd, env['PWD']]);
  } catch (error) {
    return fail(messageOf(error));
  }

  const read = await readFindingsFile(file);
  if (!read.ok) return fail(read.error);
  const parsed = parseFindingsText(read.text, roots);
  if (!parsed.ok) {
    return fail(`${fileArg} is not a valid findings file:\n${parsed.errors.map((error) => `  ${error}`).join('\n')}`);
  }

  const request: Extract<SocketRequest, { type: 'import' }> = {
    v: 1,
    type: 'import',
    dir: cwd,
    findings: parsed.findings,
    warnings: parsed.warnings,
    sources: parsed.sources,
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
  const size = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (size > MAX_IMPORT_REQUEST_BYTES) {
    return fail(`the findings of ${fileArg} take ${String(size)} bytes to send, over the ${String(MAX_IMPORT_REQUEST_BYTES / MIB)} MiB an import may carry; split the file`);
  }

  let paths: HomePaths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    return fail(messageOf(error));
  }
  const ensured = await ensureDaemon({ command: 'import', paths, explicitPort: undefined }, { ...deps, env });
  if (ensured.status === 'done') return ensured.code;

  let response;
  try {
    response = await sendRequest(ensured.info.socket, request, { timeoutMs: deps.requestTimeoutMs ?? IMPORT_CLIENT_TIMEOUT_MS });
  } catch (error) {
    return fail(`cannot reach the daemon: ${messageOf(error)}`);
  }
  if (!response.ok) return fail(isOldDaemonError(response.error) ? OLD_DAEMON_MESSAGE : response.error);

  io.stdout(`${importSummary(response)}\n`);
  if (response.anchoredAgainst === 'previous-snapshot') {
    io.stdout('The change was still being collected: the findings are anchored to its previous snapshot.\n');
  }
  for (const warning of response.warnings) io.stderr(`warning: ${warning.at}: ${warning.message}\n`);

  if (options.open === true) {
    const url = `${urlOf(ensured.info)}/#/change/${String(response.change.id)}`;
    io.stdout(`${url}\n`);
    const openUrl = deps.openUrl ?? ((target: string) => openBrowser(target));
    if (!(await openUrl(url))) io.stderr(`could not open a browser; open ${url} yourself\n`);
  }
  return 0;
}
