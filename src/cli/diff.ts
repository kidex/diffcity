// `diffcity diff [--json [--compact] [--with-sessions]] [--base <ref>] [--head <ref>]`
// (SPEC.md section 3, ADR-011, ADR-037, ADR-038). Builds the Report in-process
// through src/core; never starts the daemon. `--compact` is an output filter
// only. `--with-sessions` asks the running daemon for the Claude Code sessions
// of the change checked out here and adds them under a `sessions` key next to
// the Report's own keys; without a daemon it fails. The sessions follow the
// change checked out in the current directory, whatever --base and --head say. Session data reaches the
// output through that flag only: the Report itself never carries it.

import { identifyRepo } from '../core/changes/index.js';
import { homePaths, resolveHome } from '../core/home.js';
import type { SessionView } from '../core/model/types.js';
import { buildReport, type BuildReportOptions } from '../core/report/index.js';
import { readSettings, ruleSettingsFor, type UserRuleSettings } from '../core/settings/index.js';
import type { Report, Status, Verdict } from '../core/report/types.js';

export interface DiffCommandOptions {
  json?: boolean;
  /** With --json: leave out untouched files and the packages left with none (ADR-037). */
  compact?: boolean;
  base?: string;
  head?: string;
  /** With --json: add the sessions of the change from the running daemon (ADR-038). */
  withSessions?: boolean;
}

export type SessionsFetch = { ok: true; sessions: SessionView[] } | { ok: false; error: string };

export interface DiffDeps {
  /** Directory the command runs in; the repo is found from it. */
  cwd: string;
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  /** Injected in tests; defaults to buildReport. */
  build?: (options: BuildReportOptions) => Promise<Report>;
  /**
   * Raw value of DIFFCITY_NOW. Test-only: fixes meta.generatedAt so golden
   * reports are byte-stable. Undocumented in `--help` on purpose.
   */
  now?: string | undefined;
  /**
   * The user's rule lists for the repo (ADR-030); `warn` takes a one-line note
   * for stderr. Absent: no user rules (the CLI passes userRulesFor).
   */
  userRules?: ((warn: (message: string) => void) => Promise<UserRuleSettings>) | undefined;
  /** Fetches the sessions for --with-sessions; the CLI passes sessionsFromDaemon. */
  sessions?: (() => Promise<SessionsFetch>) | undefined;
}

/** The error of --with-sessions when no daemon answers. */
export const NO_DAEMON_FOR_SESSIONS = '--with-sessions needs the diffcity daemon, which is not running; start it with diffcity up';

/**
 * The sessions of the change checked out in `cwd`, from the running daemon
 * (the `sessions` socket request, ADR-038). Never starts a daemon.
 */
export async function sessionsFromDaemon(cwd: string, env: NodeJS.ProcessEnv): Promise<SessionsFetch> {
  // Loaded here: a plain `diff` never touches the socket client.
  const { findRunningDaemon, sendRequest } = await import('../daemon/client.js');
  let paths;
  try {
    paths = homePaths(resolveHome(env));
  } catch (error) {
    return { ok: false, error: oneLine(error) };
  }
  const running = await findRunningDaemon(paths);
  if (running === null) return { ok: false, error: NO_DAEMON_FOR_SESSIONS };
  let response;
  try {
    response = await sendRequest(running.info.socket, { v: 1, type: 'sessions', dir: cwd });
  } catch (error) {
    return { ok: false, error: `the daemon did not answer: ${oneLine(error)}` };
  }
  if (!response.ok) {
    if (/^unknown request type: sessions$|^sessions is not supported/.test(response.error)) {
      return { ok: false, error: `the running daemon (v${running.version}) predates --with-sessions; restart it with diffcity stop and diffcity up` };
    }
    return { ok: false, error: response.error };
  }
  return { ok: true, sessions: response.sessions };
}

/**
 * The user's rule lists for the repo around `cwd`, from settings.json in the
 * diffcity home, so `diff --json` carries the same checks as the daemon's
 * Report. Never fails the command: a home or settings file that cannot be
 * read is a note, and no user rule applies.
 */
export async function userRulesFor(cwd: string, env: NodeJS.ProcessEnv, warn: (message: string) => void): Promise<UserRuleSettings> {
  let file: string;
  try {
    file = homePaths(resolveHome(env)).settings;
  } catch (error) {
    warn(`${oneLine(error)}; no user rules applied`);
    return {};
  }
  const read = await readSettings(file);
  if (!read.ok) {
    warn(`settings: ${read.error}; no user rules applied`);
    return {};
  }
  if (read.settings.rules === undefined && read.settings.repos === undefined) return {};
  let root: string;
  try {
    // The key of `repos` is the repo's identity, as the daemon and trustedRepos use it:
    // the realpath of the main working tree, also from a linked worktree.
    root = (await identifyRepo(cwd)).path;
  } catch {
    // Not a repo: the build reports it.
    return {};
  }
  return ruleSettingsFor(read.settings, root);
}

/** Environment variable that fixes meta.generatedAt; only the tests set it. */
export const NOW_ENV = 'DIFFCITY_NOW';

/** Full ISO 8601 date-time with seconds and an explicit zone (`Z` or `+hh:mm`). */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether the written calendar components exist as written: `Date` silently
 * rolls over impossible values (Feb 30 becomes Mar 2, 24:00 the next day).
 */
function componentsExist(parts: readonly number[]): boolean {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second
  );
}

/** Parses DIFFCITY_NOW; throws on anything but a valid ISO 8601 date-time. */
export function parseNow(value: string): Date {
  const match = ISO_DATE_TIME.exec(value);
  const date = new Date(value);
  if (match === null || !componentsExist(match.slice(1, 7).map(Number)) || Number.isNaN(date.getTime())) {
    throw new Error(
      `${NOW_ENV} must be an ISO 8601 date-time such as 2026-01-01T00:00:00Z, got ${JSON.stringify(value)}`,
    );
  }
  return date;
}

const STATUS_ORDER: readonly Status[] = ['add', 'mod', 'sig', 'del', 'same'];
const VERDICT_ORDER: readonly Verdict[] = ['eyes', 'risky', 'spec', 'ok', 'same'];

function counts<K extends string>(order: readonly K[], values: Record<K, number>): string {
  return order.map((key) => `${key} ${String(values[key])}`).join(', ');
}

/** Short human summary of a report: counts by status and verdict, touched tier 1 files. */
export function formatSummary(report: Report): string {
  const { meta, summary } = report;
  const touched = report.packages.reduce(
    (total, pkg) => total + pkg.files.filter((file) => file.status !== 'same').length,
    0,
  );
  const commits = `${String(meta.commits)} commit${meta.commits === 1 ? '' : 's'}`;
  const lines = [
    `${meta.repo}: ${meta.base}...${meta.head} (${commits})`,
    `files: ${String(summary.files)} (${String(touched)} touched)`,
    `symbols by status: ${counts(STATUS_ORDER, summary.byStatus)}`,
    `files by verdict: ${counts(VERDICT_ORDER, summary.byVerdict)}`,
  ];
  if (summary.tier1Files.length === 0) lines.push('tier 1 files: none');
  else {
    lines.push(`tier 1 files (${String(summary.tier1Files.length)}):`);
    for (const path of summary.tier1Files) lines.push(`  ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The Report without its untouched files (`status: 'same'`) and without the
 * packages that have none left; `meta`, `steps`, `findings`, `checks` and
 * `summary` are kept as they are (ADR-037). The /diffcity-review command reads it:
 * a large repo's untouched files only cost the agent tokens.
 */
export function compactReport(report: Report): Report {
  const packages = report.packages
    .map((pkg) => ({ ...pkg, files: pkg.files.filter((file) => file.status !== 'same') }))
    .filter((pkg) => pkg.files.length > 0);
  return { ...report, packages };
}

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s*\n\s*/g, ' ').trim();
}

/** Runs the command; resolves with the process exit code (0 on success, 1 on any error). */
export async function runDiff(options: DiffCommandOptions, deps: DiffDeps): Promise<number> {
  const build = deps.build ?? buildReport;
  let sessions: SessionView[] | null = null;
  if (options.withSessions === true) {
    if (options.json !== true) {
      deps.io.stderr('diffcity diff: --with-sessions needs --json\n');
      return 1;
    }
    const fetched = deps.sessions === undefined ? { ok: false as const, error: NO_DAEMON_FOR_SESSIONS } : await deps.sessions();
    if (!fetched.ok) {
      deps.io.stderr(`diffcity diff: ${oneLine(fetched.error)}\n`);
      return 1;
    }
    sessions = fetched.sessions;
  }
  let report: Report;
  try {
    const now = deps.now === undefined ? undefined : parseNow(deps.now);
    // Run by hand inside the repo: the user chose to run its config (ADR-030).
    // Notes meant for daemon.log (the call graph's fallback) go to stderr: stdout stays the report alone.
    const log = (message: string): void => {
      deps.io.stderr(`diffcity diff: ${message}\n`);
    };
    const userRules = await deps.userRules?.(log);
    report = await build({ repoDir: deps.cwd, base: options.base, head: options.head, now, trustConfig: true, log, ...(userRules === undefined ? {} : { userRules }) });
  } catch (error) {
    deps.io.stderr(`diffcity diff: ${oneLine(error)}\n`);
    return 1;
  }
  if (options.json !== true) {
    deps.io.stdout(formatSummary(report));
    return 0;
  }
  const output = options.compact === true ? compactReport(report) : report;
  // The sessions sit next to the Report's keys, never inside the Report.
  deps.io.stdout(`${JSON.stringify(sessions === null ? output : { ...output, sessions }, null, 2)}\n`);
  return 0;
}
