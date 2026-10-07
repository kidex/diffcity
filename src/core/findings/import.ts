// An import on the daemon side (ADR-036). The CLI parses the file and sends
// the findings over the socket; the daemon checks the payload again
// (checkImportPayload: it never trusts a socket peer to have run the parsers)
// and plans the import against the change's snapshot (planImport): anchor,
// count what merged and what was skipped, and compute the `fixed` keys. Pure:
// the daemon stores the plan.
//
// Counts (docs/findings.md, "Import"):
// - imported: the findings anchored to the change, merged ones included;
// - merged: those of them that collapse into an entry that already exists,
//   stored or earlier in the same import: the same key, or the same symbol (or
//   file), category and normalized title;
// - skipped: the parse warnings that skipped an entry (`skipped: ...`) plus
//   the findings whose file is not in the change (`skipped-not-in-change`).

import type { Fingerprints } from '../model/types.js';
import type { Report } from '../report/types.js';
import { anchor, reanchor } from './anchor.js';
import { dedupIdentity } from './dedup.js';
import { fixedKeys } from './fixed.js';
import { isRuleSource, normalizePath } from './normalize.js';
import { CATEGORIES, LIMITS, SEVERITIES, STATES, type FindingInput, type ParseWarning, type StoredFinding } from './types.js';

/** What an `import` socket request carries besides `dir` and `at`. */
export interface ImportPayload {
  findings: FindingInput[];
  warnings: ParseWarning[];
  /** The sources the import covers (ParseResult.sources); defaults to those of the findings. */
  sources: string[];
}

export type ImportPayloadCheck = { ok: true; payload: ImportPayload } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A finding as the parsers produce it, rebuilt field by field; a string error otherwise. */
function checkFinding(value: unknown, at: string): FindingInput | string {
  if (!isObj(value)) return `${at} must be an object`;
  const problems: string[] = [];
  /** A string field; on a problem, records it and returns ''. */
  const required = (field: string, limit: number | null): string => {
    const given = value[field];
    if (typeof given !== 'string' || given.trim() === '') problems.push(`${at}.${field} must be a non-empty string`);
    else if (limit !== null && bytes(given) > limit) problems.push(`${at}.${field} is over ${String(limit)} bytes`);
    else return given;
    return '';
  };
  const optional = (field: string, limit: number | null): string | undefined => {
    const given = value[field];
    if (given === undefined) return undefined;
    if (typeof given !== 'string') problems.push(`${at}.${field} must be a string`);
    else if (limit !== null && bytes(given) > limit) problems.push(`${at}.${field} is over ${String(limit)} bytes`);
    else return given;
    return undefined;
  };
  const id = optional('id', null);
  const source = required('source', null);
  const file = required('file', null);
  const title = required('title', LIMITS.title);
  const message = required('message', LIMITS.message);
  const fix = optional('fix', LIMITS.fix);
  const why = optional('why', LIMITS.why);
  const [problem] = problems;
  if (problem !== undefined) return problem;
  if (source.trim() !== source || isRuleSource(source)) return `${at}.source must be a trimmed source that does not start with "rule:"`;
  const path = normalizePath(file);
  if (!path.ok || path.path !== file) return `${at}.file must be a normalized repo-relative path`;
  const severity = SEVERITIES.find((candidate) => candidate === value['severity']);
  if (severity === undefined) return `${at}.severity must be one of ${SEVERITIES.join(', ')}`;
  const category = CATEGORIES.find((candidate) => candidate === value['category']);
  if (category === undefined) return `${at}.category must be one of ${CATEGORIES.join(', ')}`;
  const state = value['state'] === undefined ? undefined : STATES.find((candidate) => candidate === value['state']);
  if (value['state'] !== undefined && state === undefined) return `${at}.state must be one of ${STATES.join(', ')}`;
  const line = value['line'];
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return `${at}.line must be an integer of 1 or more`;
  return {
    ...(id === undefined ? {} : { id }),
    source,
    severity,
    category,
    file,
    line,
    title,
    message,
    ...(fix === undefined ? {} : { fix }),
    ...(why === undefined ? {} : { why }),
    ...(state === undefined ? {} : { state }),
  };
}

/** Checks the `findings`, `warnings` and `sources` fields of an `import` request. */
export function checkImportPayload(fields: Readonly<Obj>): ImportPayloadCheck {
  const fail = (error: string): ImportPayloadCheck => ({ ok: false, error });
  const { findings, warnings, sources } = fields;
  if (!Array.isArray(findings)) return fail('findings must be an array');
  if (findings.length > LIMITS.findings) return fail(`${String(findings.length)} findings, the limit is ${String(LIMITS.findings)}`);
  const checked: FindingInput[] = [];
  for (const [index, entry] of findings.entries()) {
    const result = checkFinding(entry, `findings[${String(index)}]`);
    if (typeof result === 'string') return fail(result);
    checked.push(result);
  }
  if (!Array.isArray(warnings)) return fail('warnings must be an array');
  const notes: ParseWarning[] = [];
  for (const [index, entry] of warnings.entries()) {
    if (!isObj(entry) || typeof entry['at'] !== 'string' || typeof entry['message'] !== 'string') {
      return fail(`warnings[${String(index)}] must be { at: string, message: string }`);
    }
    notes.push({ at: entry['at'], message: entry['message'] });
  }
  if (sources !== undefined && (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string'))) {
    return fail('sources must be an array of strings');
  }
  const covered = sources === undefined ? [...new Set(checked.map((finding) => finding.source))] : [...(sources)];
  return { ok: true, payload: { findings: checked, warnings: notes, sources: covered } };
}

export interface ImportPlanInput {
  findings: readonly FindingInput[];
  warnings: readonly ParseWarning[];
  sources: readonly string[];
  /** The Report of the snapshot the import is anchored against. */
  report: Report;
  /** That snapshot's fingerprints; undefined for a snapshot from before schema v2 (nothing is fixed then). */
  fingerprints: Fingerprints | undefined;
  /** The change's stored findings, in import order. */
  stored: readonly StoredFinding[];
}

export interface ImportPlan {
  /** The anchored findings, in input order, for FindingsStore.importBatch. */
  findings: StoredFinding[];
  /** Keys of stored `open` findings that become `fixed`. */
  fixed: string[];
  imported: number;
  merged: number;
  skipped: number;
  /** The parse warnings, then one per finding skipped as not in the change. */
  warnings: ParseWarning[];
}

/** The warning of a parsed entry that was skipped (docs/findings.md). */
const isSkipWarning = (warning: ParseWarning): boolean => warning.message.startsWith('skipped');

export function planImport(input: ImportPlanInput): ImportPlan {
  const { report, fingerprints } = input;
  const keys = new Set(input.stored.map((entry) => entry.key));
  const identities = new Set<string>();
  for (const entry of input.stored) {
    const current = reanchor(entry, report);
    if (current !== null) identities.add(dedupIdentity(current));
  }

  const findings: StoredFinding[] = [];
  const warnings: ParseWarning[] = [...input.warnings];
  let merged = 0;
  let notInChange = 0;
  for (const finding of input.findings) {
    const result = anchor(finding, report, fingerprints);
    if (!result.ok) {
      notInChange++;
      warnings.push({ at: `${finding.file}:${String(finding.line)}`, message: `skipped-not-in-change: "${finding.file}" is not part of the change` });
      continue;
    }
    const identity = dedupIdentity(result.stored.finding);
    if (keys.has(result.stored.key) || identities.has(identity)) merged++;
    keys.add(result.stored.key);
    identities.add(identity);
    findings.push(result.stored);
  }

  const fixed =
    fingerprints === undefined ? [] : fixedKeys({ stored: input.stored, imported: findings, report, fingerprints, sources: input.sources });
  return {
    findings,
    fixed,
    imported: findings.length,
    merged,
    skipped: input.warnings.filter(isSkipWarning).length + notInChange,
    warnings,
  };
}
