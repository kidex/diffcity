// Assembles the Report of one change (SPEC.md section 4.1, ADR-011).
// `diffcity diff --json` calls buildReport in-process; the daemon will too.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ConfigError, loadConfig, type DiffcityConfig } from '../config/index.js';
import { compareFileWithFingerprints, unchangedSymbolsWithFingerprints, type FileChange } from '../diff/status.js';
import {
  changedFiles,
  computeMeta,
  countLines,
  findRepoRoot,
  listHeadFiles,
  looksBinary,
  measureAfter,
  readAfter,
  readAfterBatch,
  hashAfter,
  hashBefore,
  readAfterBytes,
  readBeforeBytes,
  resolveChange,
  sizeAfter,
  sizeAfterBatch,
  sizeBefore,
  type ChangedFile,
  type CommandRunner,
  type ResolvedChange,
} from '../git/index.js';
import type { FileFingerprint, Fingerprints } from '../model/types.js';
import { MAX_PARSE_BYTES } from '../parse/file.js';
import { languageForPath } from '../parse/language.js';
import { buildExecutionPath } from '../path/order.js';
import { loadTsMorph, readTsconfigPaths, tsconfigParses } from '../path/graph.js';
import {
  beforeFilesOf,
  measureNeeds,
  mergeRules,
  rulesNeedImports,
  rulesNeedTsconfigPaths,
  runRules,
  type MergedRule,
  type RuleContext,
  type RuleFile,
  type RuleRun,
} from '../rules/index.js';
import type { UserRuleSettings } from '../settings/settings.js';
import { preparePathFile, prepareUntouchedFile, type PathFile } from '../path/prepare.js';
import { readRepoSpec, specLocation, specScope, TOO_LARGE_NOTICE, type SpecScope, type SpecSource } from '../spec/index.js';
import { fileVerdict, tier1Matcher, touchedTier1Files } from '../verdict/index.js';
import { mapLimit } from './limit.js';
import type { File, Finding, Package, Report, Status, Step, Symbol, Verdict } from './types.js';

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
  /**
   * Whether the repo's diffcity.config.js may be imported (see loadConfig):
   * true for `diffcity diff` run by hand, the trust list's answer in the
   * daemon. Without trust the defaults apply. Required on purpose.
   */
  trustConfig: boolean;
  /** Receives the one-line notes meant for daemon.log (the call graph's fallback to name matching). */
  log?: ((message: string) => void) | undefined;
  /**
   * The user's rule lists for this repo from settings.json (ADR-030), merged
   * before the repo config's `rules` (read only when `trustConfig`). Absent:
   * no user rules.
   */
  userRules?: UserRuleSettings | undefined;
  /**
   * The spec from `diffcity diff --spec <file>` (readSpecFile); it takes
   * precedence over `.diffcity/spec.md`, which is read otherwise (ADR-035).
   */
  spec?: SpecSource | undefined;
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

/** Root files the execution path reads as data (tsconfig `paths`, package.json `bin`/`main`) up to this size. */
export const MAX_PATH_CONFIG_BYTES = 1024 * 1024;

/** The execution path of a report: its steps and the call sites of its `sig` symbols (ADR-034), and what spec scope reads of it (ADR-035). */
export interface ReportPath {
  steps: Step[];
  callsites: ReadonlyMap<string, number>;
  /** The call graph: caller symbol id to its callees. */
  edges?: ReadonlyMap<string, readonly { to: string }[]>;
  /** Touched symbol id to the HTTP routes it registers or handles (routeRegistrations, ADR-034 facts). */
  routes?: ReadonlyMap<string, readonly { method: string; path: string }[]>;
}

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
 * Groups files into packages and computes verdicts and the summary, and
 * places the execution path: its steps, and Symbol.callsites on every `sig`
 * symbol. Pure: the same input gives the same Report, in a deterministic order.
 */
export function assembleReport(
  meta: Report['meta'],
  inputs: readonly ReportFileInput[],
  isTier1: (path: string) => boolean,
  path: ReportPath = { steps: [], callsites: new Map() },
  rules: RuleRun | null = null,
  spec: SpecScope | null = null,
): Report {
  // Rule findings are part of the Report and count for the verdict like any open finding (SPEC.md 5.2, ADR-030).
  const findingsOf = new Map<string, Finding[]>();
  for (const finding of rules?.findings ?? []) {
    const list = findingsOf.get(finding.file);
    if (list === undefined) findingsOf.set(finding.file, [finding]);
    else list.push(finding);
  }

  const byPackage = new Map<string, File[]>();
  const byStatus: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
  const byVerdict: Record<Verdict, number> = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };

  for (const input of [...inputs].sort((a, b) => compareStrings(a.path, b.path))) {
    const verdict = fileVerdict({
      status: input.status,
      symbolStatuses: input.symbols.map((symbol) => symbol.status),
      tier1: isTier1(input.path),
      // Imported findings join on each served Report (the findings overlay, ADR-036).
      findings: findingsOf.get(input.path) ?? [],
      inSpec: spec?.inSpec?.get(input.path) ?? null,
    });
    const file: File = {
      id: input.path,
      path: input.path,
      language: input.language,
      status: input.status,
      verdict,
      // True or false for a touched file when the spec named a root; null otherwise (ADR-035).
      inSpec: spec?.inSpec?.get(input.path) ?? null,
      symbols: input.symbols.map((symbol) =>
        symbol.status === 'sig' ? { ...symbol, callsites: path.callsites.get(symbol.id) ?? 0 } : symbol,
      ),
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
    steps: path.steps,
    findings: rules?.findings ?? [],
    // Present only with a configured rule, so a Report without rules is unchanged.
    ...(rules === null || rules.checks.length === 0 ? {} : { checks: rules.checks }),
    // Present only for a spec that marks nothing, so a Report without a spec is unchanged.
    ...(spec?.notice === null || spec?.notice === undefined ? {} : { specNotice: spec.notice }),
    summary: {
      files: files.length,
      byStatus,
      byVerdict,
      tier1Files: touchedTier1Files(files, isTier1),
    },
  };
}

/** A described file, with what the fingerprints need. */
interface Described {
  input: ReportFileInput;
  fingerprint: FileFingerprint;
  symbolFingerprints: Record<string, string>;
  /** What the execution path needs from the file; absent for a file that plays no part in it. */
  path?: PathFile | undefined;
  /** Size and lines of the after version, when a rule asked and the content was in memory; null for a deleted file. */
  after?: RuleFile['after'] | undefined;
  /** The before path of a renamed file. */
  oldPath?: string | undefined;
  /** The imports of both versions, taken from the parse trees when a layers rule runs (ADR-031). */
  imports?: RuleFile['imports'];
}

function sha256(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

/**
 * What the rules need about a file: `lines` asks for the line count as well as
 * the size. Null when no rule looks at the file.
 */
type MeasureNeeds = (path: string) => { lines: boolean } | null;

async function describeChanged(change: ResolvedChange, file: ChangedFile, needs: MeasureNeeds, imports: boolean): Promise<Described> {
  const oldPath = file.oldPath ?? file.path;
  // Only code files are read into memory and parsed: the status of anything else comes from git (ADR-008).
  // The others are hashed from a stream, so a large asset never sits in the worker's memory.
  // A code file with a side above MAX_PARSE_BYTES counts as one of the others, judged from the object
  // header or lstat before any read, so before and after always get the same treatment.
  let readable = !file.binary && (languageForPath(oldPath) !== null || languageForPath(file.path) !== null);
  if (readable) {
    const [beforeSize, afterSize] = await Promise.all([
      file.type === 'add' ? null : sizeBefore(change, oldPath),
      file.type === 'del' ? null : sizeAfter(change, file.path),
    ]);
    readable = (beforeSize ?? 0) <= MAX_PARSE_BYTES && (afterSize ?? 0) <= MAX_PARSE_BYTES;
  }
  const [beforeBytes, afterBytes] = readable
    ? await Promise.all([
        file.type === 'add' ? null : readBeforeBytes(change, oldPath),
        file.type === 'del' ? null : readAfterBytes(change, file.path),
      ])
    : [null, null];
  // A file that grew between the size check and the read is dropped from parsing, like an unread one.
  const grown = (beforeBytes?.length ?? 0) > MAX_PARSE_BYTES || (afterBytes?.length ?? 0) > MAX_PARSE_BYTES;
  const [beforeHash, afterHash] = readable
    ? [sha256(beforeBytes), sha256(afterBytes)]
    : await Promise.all([
        file.type === 'add' ? null : hashBefore(change, oldPath),
        file.type === 'del' ? null : hashAfter(change, file.path),
      ]);
  const before = grown ? null : (beforeBytes?.toString('utf8') ?? null);
  const after = grown ? null : (afterBytes?.toString('utf8') ?? null);
  // binary: git decides the status, with no symbols, for a file that was not parsed.
  const input: FileChange = { path: file.path, change: file.type, binary: file.binary || !readable || grown, before, after };
  if (oldPath !== file.path) input.oldPath = oldPath;
  const compared = await compareFileWithFingerprints(input, { imports });
  const { status, symbols, symbolFingerprints, ranges } = compared;
  const fingerprint: FileFingerprint = { before: beforeHash, after: afterHash };
  if (oldPath !== file.path) fingerprint.oldPath = oldPath;
  const described: Described = { input: { path: file.path, language: languageOf(file.path), status, symbols }, fingerprint, symbolFingerprints };
  if (oldPath !== file.path) described.oldPath = oldPath;
  if (compared.imports !== undefined) described.imports = compared.imports;
  const wanted = file.type === 'del' ? null : needs(file.path);
  // Measured now while the bytes are in memory; anything else is measured later (ruleRunOf).
  if (wanted !== null && afterBytes !== null) {
    described.after = { bytes: afterBytes.length, lines: wanted.lines && !looksBinary(afterBytes) ? countLines(afterBytes) : null };
  }
  // A touched code file that was parsed: its steps' diffs and entry facts are taken now, while both versions are in memory.
  if (status !== 'same' && !input.binary) {
    described.path = await preparePathFile({ path: file.path, oldPath, status, before, after, symbols, ranges });
  } else if (!input.binary && after !== null) {
    // Touched but `same` (reformatted only): like an untouched file, its registrations can make a handler an entry.
    described.path = (await prepareUntouchedFile(file.path, after, symbols)) ?? undefined;
  }
  return described;
}

async function describeUnchanged(path: string, bytes: Buffer | null): Promise<Described | null> {
  // Gone between listing and reading: not part of this state any more.
  if (bytes === null) return null;
  const hash = sha256(bytes);
  const file: ReportFileInput = { path, language: languageOf(path), status: 'same', symbols: [] };
  const described: Described = { input: file, fingerprint: { before: hash, after: hash }, symbolFingerprints: {} };
  // A code extension on binary content (an MPEG-TS `.ts`, say) has no symbols; git's rule decides.
  if (looksBinary(bytes)) return described;
  const text = bytes.toString('utf8');
  const parsed = await unchangedSymbolsWithFingerprints(path, text);
  file.symbols = parsed.symbols;
  described.symbolFingerprints = parsed.symbolFingerprints;
  // An untouched route, command or job registration can make a touched handler an entry point (ADR-034).
  described.path = (await prepareUntouchedFile(path, text, parsed.symbols)) ?? undefined;
  return described;
}

/** An untouched file above MAX_PARSE_BYTES: hashed from a stream, `same`, no symbols. */
async function describeUnchangedLarge(change: ResolvedChange, path: string): Promise<Described | null> {
  const hash = await hashAfter(change, path);
  if (hash === null) return null;
  return {
    input: { path, language: languageOf(path), status: 'same', symbols: [] },
    fingerprint: { before: hash, after: hash },
    symbolFingerprints: {},
  };
}

/** A root file of the after state as text, or `null` when it is missing or larger than MAX_PATH_CONFIG_BYTES. */
async function readRootConfig(change: ResolvedChange, path: string): Promise<string | null> {
  const size = await sizeAfter(change, path);
  if (size === null || size > MAX_PATH_CONFIG_BYTES) return null;
  return readAfter(change, path);
}

/** The execution path over the prepared files; nothing to compute (and no ts-morph) without a touched code file. */
async function executionPathOf(
  change: ResolvedChange,
  described: readonly Described[],
  log: ((message: string) => void) | undefined,
  readTsconfig: () => Promise<string | null>,
): Promise<ReportPath> {
  const files = described.flatMap((entry) => entry.path ?? []);
  if (!files.some((file) => file.status !== 'same')) return { steps: [], callsites: new Map() };
  const [tsconfig, packageJson] = await Promise.all([readTsconfig(), readRootConfig(change, 'package.json')]);
  const { steps, callsites, edges, routes } = await buildExecutionPath({ files, tsconfig, packageJson, log });
  return { steps, callsites, edges, routes };
}

/**
 * The spec scope of a change (SPEC.md 5.5, ADR-035), over the execution
 * path's call graph: null without a spec, a notice for a spec too large to read.
 */
async function specScopeOf(
  source: SpecSource,
  root: string,
  inputs: readonly ReportFileInput[],
  path: ReportPath,
): Promise<SpecScope | null> {
  if (source.kind === 'absent') return null;
  if (source.kind === 'too-large') return { inSpec: null, notice: TOO_LARGE_NOTICE };
  const location = await specLocation(source, root);
  return specScope({
    text: source.text,
    specPath: location.path,
    // Null for `.diffcity/spec.md`: specScope resolves its links from `.diffcity/`.
    ...(location.linkBase === null ? {} : { linkBase: location.linkBase }),
    files: inputs,
    edges: path.edges ?? new Map(),
    routes: path.routes ?? new Map(),
  });
}

/** The rules of a build: the user's lists, then the repo config's (loaded only for a trusted repo). */
function rulesOf(options: BuildReportOptions, config: DiffcityConfig): MergedRule[] {
  return mergeRules({
    ...(options.userRules?.settings === undefined ? {} : { settings: options.userRules.settings }),
    ...(options.userRules?.settingsRepo === undefined ? {} : { settingsRepo: options.userRules.settingsRepo }),
    ...(config.rules === undefined ? {} : { repoConfig: config.rules }),
  });
}

/**
 * Runs the rules over the touched files: the ones whose after version was not
 * in memory (non-code, binary, large) are measured from a stream, and only
 * when a rule looks at them.
 */
async function ruleRunOf(
  change: ResolvedChange,
  rules: readonly MergedRule[],
  described: readonly Described[],
  checkedAt: string,
  context: () => Promise<RuleContext>,
): Promise<RuleRun | null> {
  if (rules.length === 0) return null;
  const files = await mapLimit(
    described.filter((entry) => entry.input.status !== 'same'),
    PARSE_CONCURRENCY,
    async (entry): Promise<RuleFile> => {
      const { path, status, symbols } = entry.input;
      let after = entry.after ?? null;
      const wanted = status === 'del' ? null : measureNeeds(rules, path);
      if (entry.after === undefined && wanted !== null) {
        const measured = wanted.lines ? await measureAfter(change, path) : await sizeAfter(change, path).then((bytes) => (bytes === null ? null : { bytes, lines: null }));
        after = measured;
      }
      return { path, ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }), status, symbols, after, ...(entry.imports === undefined ? {} : { imports: entry.imports }) };
    },
  );
  return runRules(rules, files, checkedAt, await context());
}

/** Runs `read` once, on the first call; later calls share its promise. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= read());
}

/**
 * What the layers rule needs of the whole snapshot (ADR-031): the after file
 * list, the before one derived from it and the changed files, and, for a rule
 * with `useTsconfigPaths`, the root tsconfig's `compilerOptions.paths` read
 * from the after state as data (`extends` not followed).
 */
async function ruleContextOf(
  rules: readonly MergedRule[],
  headFiles: readonly string[],
  changed: readonly ChangedFile[],
  readTsconfig: () => Promise<string | null>,
): Promise<RuleContext> {
  if (!rulesNeedImports(rules)) return { afterFiles: new Set(), beforeFiles: new Set(), tsconfigPaths: null };
  const context: RuleContext = { afterFiles: new Set(headFiles), beforeFiles: new Set(beforeFilesOf(headFiles, changed)), tsconfigPaths: null };
  if (!rulesNeedTsconfigPaths(rules)) return context;
  // Missing (or above MAX_PATH_CONFIG_BYTES, which readRootConfig does not read) is "not found".
  const tsconfig = await readTsconfig();
  if (tsconfig === null) return { ...context, tsconfigProblem: 'not found' };
  const { ts } = await loadTsMorph();
  if (!tsconfigParses(tsconfig, ts)) return { ...context, tsconfigProblem: 'could not be parsed' };
  return { ...context, tsconfigPaths: readTsconfigPaths(tsconfig, ts) };
}

/**
 * Builds the Report of the change in `repoDir`: every file touched between
 * before (merge-base) and after, plus the untouched files of the after state
 * in a supported language, as `same`.
 */
export async function buildReport(options: BuildReportOptions): Promise<Report> {
  return (await buildReportWithHead(options)).report;
}

/**
 * buildReport, plus the sha the after state is built on (the `--head` commit,
 * or HEAD for the working tree), the merge-base the before state is read from,
 * and the fingerprints of files and symbols (ADR-027). The Report itself does
 * not carry them.
 */
export async function buildReportWithHead(
  options: BuildReportOptions,
): Promise<{ report: Report; headCommit: string; mergeBase: string; fingerprints: Fingerprints }> {
  const root = await findRepoRoot(options.repoDir);
  const config = await loadConfig(root, { trusted: options.trustConfig });
  const isTier1 = tier1For(config);
  const change = await resolveChange(root, {
    base: options.base,
    head: options.head,
    config,
    runner: options.runner,
  });

  const [meta, changed, headFiles, spec] = await Promise.all([
    computeMeta(change, options.now),
    changedFiles(change),
    listHeadFiles(change),
    // `--spec` wins; `.diffcity/spec.md` is not even read then.
    options.spec ?? readRepoSpec(change),
  ]);
  const touched = new Set(changed.map((file) => file.path));
  const untouched = headFiles.filter((path) => !touched.has(path) && languageForPath(path) !== null);

  const rules = rulesOf(options, config);
  const needs: MeasureNeeds = (path) => measureNeeds(rules, path);
  const imports = rulesNeedImports(rules);
  const touchedInputs = await mapLimit(changed, PARSE_CONCURRENCY, (file) => describeChanged(change, file, needs, imports));
  const untouchedInputs: (Described | null)[] = [];
  for (let i = 0; i < untouched.length; i += READ_BATCH_SIZE) {
    const paths = untouched.slice(i, i + READ_BATCH_SIZE);
    // Sizes first: a file above MAX_PARSE_BYTES is hashed from a stream and never joins the buffered batch.
    const sizes = await sizeAfterBatch(change, paths);
    const small = paths.filter((_, j) => (sizes[j] ?? 0) <= MAX_PARSE_BYTES);
    const contents = await readAfterBatch(change, small);
    const bytesOf = new Map(small.map((path, j) => [path, contents[j] ?? null]));
    untouchedInputs.push(
      ...(await mapLimit(paths, PARSE_CONCURRENCY, (path) =>
        bytesOf.has(path) ? describeUnchanged(path, bytesOf.get(path) ?? null) : describeUnchangedLarge(change, path),
      )),
    );
  }

  const described = [...touchedInputs, ...untouchedInputs.filter((input): input is Described => input !== null)];
  // Read at most once, for the execution path and the layers rule alike.
  const readTsconfig = once(() => readRootConfig(change, 'tsconfig.json'));
  const inputs = described.map((entry) => entry.input);
  // One pass: the spec scope walks the call graph the execution path built (ADR-035).
  const path = await executionPathOf(change, described, options.log, readTsconfig);
  const report = assembleReport(
    meta,
    inputs,
    isTier1,
    path,
    // checkedAt is the Report's own time: the content hash leaves both out (contentHashOf).
    await ruleRunOf(change, rules, touchedInputs, meta.generatedAt, () => ruleContextOf(rules, headFiles, changed, readTsconfig)),
    await specScopeOf(spec, root, inputs, path),
  );
  const fingerprints: Fingerprints = { files: {}, symbols: {} };
  for (const entry of described) {
    fingerprints.files[entry.input.path] = entry.fingerprint;
    Object.assign(fingerprints.symbols, entry.symbolFingerprints);
  }
  return { report, headCommit: change.headCommit, mergeBase: change.mergeBase, fingerprints };
}
