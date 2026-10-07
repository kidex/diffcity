// `diffcity diff [--json [--compact]] [--base <ref>] [--head <ref>]` (SPEC.md
// section 3, ADR-011, ADR-037). Builds the Report in-process through src/core;
// never starts or contacts the daemon. `--compact` is an output filter only.

import { buildReport, type BuildReportOptions } from '../core/report/index.js';
import type { Report, Status, Verdict } from '../core/report/types.js';

export interface DiffCommandOptions {
  json?: boolean;
  /** With --json: leave out untouched files and the packages left with none (ADR-037). */
  compact?: boolean;
  base?: string;
  head?: string;
}

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
  let report: Report;
  try {
    const now = deps.now === undefined ? undefined : parseNow(deps.now);
    // Run by hand inside the repo: the user chose to run its config (ADR-030).
    // Notes meant for daemon.log (the call graph's fallback) go to stderr: stdout stays the report alone.
    const log = (message: string): void => {
      deps.io.stderr(`diffcity diff: ${message}\n`);
    };
    report = await build({ repoDir: deps.cwd, base: options.base, head: options.head, now, trustConfig: true, log });
  } catch (error) {
    deps.io.stderr(`diffcity diff: ${oneLine(error)}\n`);
    return 1;
  }
  if (options.json !== true) {
    deps.io.stdout(formatSummary(report));
    return 0;
  }
  const output = options.compact === true ? compactReport(report) : report;
  deps.io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}
