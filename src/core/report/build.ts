// Assembles the Report of one change (SPEC.md section 4.1, ADR-011).
// `diffcity diff --json` calls buildReport in-process; the daemon will too.

import { posix } from 'node:path';
import { ConfigError, loadConfig, type DiffcityConfig } from '../config/index.js';
import { compareFile, unchangedSymbols, type FileChange } from '../diff/status.js';
import {
  changedFiles,
  computeMeta,
  findRepoRoot,
  listHeadFiles,
  looksBinary,
  readAfter,
  readAfterBatch,
  readBefore,
  resolveChange,
  type ChangedFile,
  type CommandRunner,
  type ResolvedChange,
} from '../git/index.js';
import { languageForPath } from '../parse/language.js';
import { fileVerdict, tier1Matcher, touchedTier1Files } from '../verdict/index.js';
import { mapLimit } from './limit.js';
import type { File, Package, Report, Status, Symbol, Verdict } from './types.js';

export interface BuildReportOptions {
  /** Any directory inside the repo's working tree. */
  repoDir: string;
  /** `--base`; falls back to the config, then auto-detection (ADR-012). */
  base?: string | undefined;
  /** `--head`; without it the working tree is compared. */
  head?: string | undefined;
  /** Used for meta.generatedAt; defaults to the current time. */
  now?: Date | undefined;
  /** Runs `gh` during base detection; tests inject a fake. */
  runner?: CommandRunner | undefined;
}

/** A file ready to be placed in the report, before verdict and grouping. */
export interface ReportFileInput {
  path: string;
  language: string;
  status: Status;
  symbols: Symbol[];
}

/** Files read and parsed at the same time. Parsing moves to worker threads with the collector (phase 2). */
export const PARSE_CONCURRENCY = 8;

/** Untouched files read per batch (one `git cat-file --batch` call for a commit). */
export const READ_BATCH_SIZE = 256;

/** `File.language` for files diffcity does not parse. */
export const UNSUPPORTED_LANGUAGE = 'other';

/** The package of a file: its parent directory, `.` at the repo root (ADR-011). */
export function packagePathOf(path: string): string {
  return posix.dirname(path);
}

function languageOf(path: string): string {
  return languageForPath(path) ?? UNSUPPORTED_LANGUAGE;
}

/** Code unit order: stable across locales and machines. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tier1For(config: DiffcityConfig): (path: string) => boolean {
  try {
    return tier1Matcher(config.tier1);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`diffcity.config.js: field "tier1" failed: ${reason}`, 'tier1', { cause: error });
  }
}

/**
 * Groups files into packages and computes verdicts and the summary. Pure:
 * the same input gives the same Report, in a deterministic order.
 */
export function assembleReport(
  meta: Report['meta'],
  inputs: readonly ReportFileInput[],
  isTier1: (path: string) => boolean,
): Report {
  const byPackage = new Map<string, File[]>();
  const byStatus: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
  const byVerdict: Record<Verdict, number> = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };

  for (const input of [...inputs].sort((a, b) => compareStrings(a.path, b.path))) {
    const verdict = fileVerdict({
      status: input.status,
      symbolStatuses: input.symbols.map((symbol) => symbol.status),
      tier1: isTier1(input.path),
      // Findings are imported in phase 4.
      findings: [],
      // No spec scope before phase 4 (ADR-010).
      inSpec: null,
    });
    const file: File = {
      id: input.path,
      path: input.path,
      language: input.language,
      status: input.status,
      verdict,
      inSpec: null,
      symbols: input.symbols,
    };
    byVerdict[verdict] += 1;
    for (const symbol of input.symbols) byStatus[symbol.status] += 1;

    const packagePath = packagePathOf(input.path);
    const files = byPackage.get(packagePath);
    if (files === undefined) byPackage.set(packagePath, [file]);
    else files.push(file);
  }

  const packages: Package[] = [...byPackage.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([path, files]) => ({ id: path, path, tier1: isTier1(path), files }));
  const files = packages.flatMap((pkg) => pkg.files);

  return {
    meta,
    packages,
    steps: [],
    findings: [],
    summary: {
      files: files.length,
      byStatus,
      byVerdict,
      tier1Files: touchedTier1Files(files, isTier1),
    },
  };
}

async function describeChanged(change: ResolvedChange, file: ChangedFile): Promise<ReportFileInput> {
  const oldPath = file.oldPath ?? file.path;
  // Only code files are read: the status of anything else comes from git (ADR-008).
  const readable = !file.binary && (languageForPath(oldPath) !== null || languageForPath(file.path) !== null);
  const [before, after] = readable
    ? await Promise.all([
        file.type === 'add' ? null : readBefore(change, oldPath),
        file.type === 'del' ? null : readAfter(change, file.path),
      ])
    : [null, null];
  const input: FileChange = { path: file.path, change: file.type, binary: file.binary, before, after };
  if (oldPath !== file.path) input.oldPath = oldPath;
  const { status, symbols } = await compareFile(input);
  return { path: file.path, language: languageOf(file.path), status, symbols };
}

async function describeUnchanged(path: string, bytes: Buffer | null): Promise<ReportFileInput | null> {
  // Gone between listing and reading: not part of this state any more.
  if (bytes === null) return null;
  const file: ReportFileInput = { path, language: languageOf(path), status: 'same', symbols: [] };
  // A code extension on binary content (an MPEG-TS `.ts`, say) has no symbols; git's rule decides.
  if (looksBinary(bytes)) return file;
  file.symbols = await unchangedSymbols(path, bytes.toString('utf8'));
  return file;
}

/**
 * Builds the Report of the change in `repoDir`: every file touched between
 * before (merge-base) and after, plus the untouched files of the after state
 * in a supported language, as `same`.
 */
export async function buildReport(options: BuildReportOptions): Promise<Report> {
  return (await buildReportWithHead(options)).report;
}

/** buildReport, plus the sha the after state is built on (the `--head` commit, or HEAD for the working tree). */
export async function buildReportWithHead(options: BuildReportOptions): Promise<{ report: Report; headCommit: string }> {
  const root = await findRepoRoot(options.repoDir);
  const config = await loadConfig(root);
  const isTier1 = tier1For(config);
  const change = await resolveChange(root, {
    base: options.base,
    head: options.head,
    config,
    runner: options.runner,
  });

  const [meta, changed, headFiles] = await Promise.all([
    computeMeta(change, options.now),
    changedFiles(change),
    listHeadFiles(change),
  ]);
  const touched = new Set(changed.map((file) => file.path));
  const untouched = headFiles.filter((path) => !touched.has(path) && languageForPath(path) !== null);

  const touchedInputs = await mapLimit(changed, PARSE_CONCURRENCY, (file) => describeChanged(change, file));
  const untouchedInputs: (ReportFileInput | null)[] = [];
  for (let i = 0; i < untouched.length; i += READ_BATCH_SIZE) {
    const paths = untouched.slice(i, i + READ_BATCH_SIZE);
    const contents = await readAfterBatch(change, paths);
    untouchedInputs.push(
      ...(await mapLimit(paths, PARSE_CONCURRENCY, (path, j) => describeUnchanged(path, contents[j] ?? null))),
    );
  }

  const report = assembleReport(
    meta,
    [...touchedInputs, ...untouchedInputs.filter((input): input is ReportFileInput => input !== null)],
    isTier1,
  );
  return { report, headCommit: change.headCommit };
}
