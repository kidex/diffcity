// Own-format and SARIF 2.1 parsing (ADR-036, docs/findings.md). Pure.

import { normalizePath } from './normalize.js';
import {
  CATEGORIES,
  LIMITS,
  SEVERITIES,
  STATES,
  type FindingCategory,
  type FindingInput,
  type FindingSeverity,
  type ParseResult,
  type ParseWarning,
} from './types.js';

const MAX_ERRORS = 20;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' ? allowed.find((candidate) => candidate === value) : undefined;
}

/** Checks the size limits shared by both formats; returns the messages of the ones broken. */
function sizeErrors(at: string, input: { title: string; message: string; fix?: string }): string[] {
  const errors: string[] = [];
  if (bytes(input.message) > LIMITS.message) errors.push(`${at}: message is over ${String(LIMITS.message)} bytes`);
  if (bytes(input.title) > LIMITS.title) errors.push(`${at}: title is over ${String(LIMITS.title)} bytes`);
  if (input.fix !== undefined && bytes(input.fix) > LIMITS.fix) errors.push(`${at}: fix is over ${String(LIMITS.fix)} bytes`);
  return errors;
}

function tooMany(count: number): string | undefined {
  return count > LIMITS.findings ? `${String(count)} findings, the limit is ${String(LIMITS.findings)}` : undefined;
}

/** Own format: an array of findings without `symbolId`. Any invalid entry rejects the file; a bad path skips the entry. */
export function parseOwn(json: unknown, repoRoot?: string): ParseResult {
  if (!Array.isArray(json)) return { ok: false, errors: ['the file must be a JSON array of findings'] };
  const overLimit = tooMany(json.length);
  if (overLimit !== undefined) return { ok: false, errors: [overLimit] };

  const errors: string[] = [];
  const warnings: ParseWarning[] = [];
  const findings: FindingInput[] = [];
  const sources = new Set<string>();

  json.forEach((entry: unknown, index) => {
    const at = `findings[${String(index)}]`;
    if (!isObj(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const problems: string[] = [];
    const text = (field: string, required: boolean): string | undefined => {
      const value = entry[field];
      if (value === undefined) {
        if (required) problems.push(`${at}.${field}: required`);
        return undefined;
      }
      if (typeof value !== 'string' || (required && value.trim() === '')) {
        problems.push(`${at}.${field}: must be a${required ? ' non-empty' : ''} string`);
        return undefined;
      }
      return value;
    };
    const id = text('id', false);
    const source = text('source', true);
    const title = text('title', true);
    const message = text('message', true);
    const file = text('file', true);
    const fix = text('fix', false);
    const why = text('why', false);
    const severity = oneOf<FindingSeverity>(entry['severity'], SEVERITIES);
    if (severity === undefined) problems.push(`${at}.severity: must be one of ${SEVERITIES.join(', ')}`);
    const category = oneOf<FindingCategory>(entry['category'], CATEGORIES);
    if (category === undefined) problems.push(`${at}.category: must be one of ${CATEGORIES.join(', ')}`);
    const state = entry['state'] === undefined ? undefined : oneOf(entry['state'], STATES);
    if (entry['state'] !== undefined && state === undefined) problems.push(`${at}.state: must be one of ${STATES.join(', ')}`);
    const line = entry['line'];
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) problems.push(`${at}.line: must be an integer of 1 or more`);

    if (problems.length > 0 || source === undefined || title === undefined || message === undefined || file === undefined || severity === undefined || category === undefined || typeof line !== 'number') {
      errors.push(...problems);
      return;
    }
    const sizes = sizeErrors(at, { title, message, ...(fix === undefined ? {} : { fix }) });
    if (sizes.length > 0) {
      errors.push(...sizes);
      return;
    }
    sources.add(source.trim());
    const path = normalizePath(file, repoRoot);
    if (!path.ok) {
      warnings.push({ at, message: `skipped: ${path.reason}` });
      return;
    }
    findings.push({
      ...(id === undefined || id === '' ? {} : { id }),
      source: source.trim(),
      severity,
      category,
      file: path.path,
      line,
      title: title.trim(),
      message,
      ...(fix === undefined || fix === '' ? {} : { fix }),
      ...(why === undefined || why.trim() === '' ? {} : { why: why.trim() }),
      ...(state === undefined ? {} : { state }),
    });
  });

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, findings, warnings, sources: [...sources] };
}

function sarifSeverity(level: unknown): FindingSeverity {
  return level === 'error' ? 'high' : level === 'warning' ? 'med' : 'low';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** SARIF 2.1: each `runs[].results[]` entry becomes one finding, mapped as in docs/findings.md. */
export function parseSarif(json: unknown, repoRoot: string): ParseResult {
  if (!isObj(json) || !Array.isArray(json['runs'])) {
    return { ok: false, errors: ['not a SARIF 2.1 log: "runs" must be an array'] };
  }
  const runs: unknown[] = json['runs'];
  const total = runs.reduce<number>((sum, run) => {
    const results = isObj(run) ? run['results'] : undefined;
    return sum + (Array.isArray(results) ? results.length : 0);
  }, 0);
  const overLimit = tooMany(total);
  if (overLimit !== undefined) return { ok: false, errors: [overLimit] };

  const errors: string[] = [];
  const warnings: ParseWarning[] = [];
  const findings: FindingInput[] = [];
  const sources = new Set<string>();

  runs.forEach((run, runIndex) => {
    // A run without `results` did not compute any (SARIF 2.1 3.14.23): it covers nothing.
    if (!isObj(run) || !Array.isArray(run['results'])) return;
    const tool = isObj(run['tool']) ? run['tool'] : {};
    const driver = isObj(tool['driver']) ? tool['driver'] : {};
    const source = str(driver['name'])?.trim() ?? 'sarif';
    sources.add(source);
    (run['results'] as unknown[]).forEach((result, resultIndex) => {
      const at = `runs[${String(runIndex)}].results[${String(resultIndex)}]`;
      if (!isObj(result)) {
        warnings.push({ at, message: 'skipped: not an object' });
        return;
      }
      const locations = Array.isArray(result['locations']) ? (result['locations'] as unknown[]) : [];
      const first = locations[0];
      const physical = isObj(first) && isObj(first['physicalLocation']) ? first['physicalLocation'] : undefined;
      const artifact = physical !== undefined && isObj(physical['artifactLocation']) ? physical['artifactLocation'] : undefined;
      const uri = artifact === undefined ? undefined : str(artifact['uri']);
      if (physical === undefined || uri === undefined) {
        warnings.push({ at, message: 'skipped: no physical location' });
        return;
      }
      const path = normalizePath(uri, repoRoot);
      if (!path.ok) {
        warnings.push({ at, message: `skipped: ${path.reason}` });
        return;
      }
      const messageText = isObj(result['message']) ? str(result['message']['text']) : undefined;
      const ruleId = str(result['ruleId']);
      const title = ruleId ?? messageText;
      if (title === undefined) {
        warnings.push({ at, message: 'skipped: no ruleId and no message text' });
        return;
      }
      const region = isObj(physical['region']) ? physical['region'] : {};
      const startLine = region['startLine'];
      let line = 1;
      if (typeof startLine === 'number' && Number.isInteger(startLine) && startLine >= 1) line = startLine;
      else warnings.push({ at, message: 'no region.startLine, line 1 used' });

      const props = isObj(result['properties']) ? result['properties'] : {};
      let category: FindingCategory = 'correctness';
      if (props['category'] !== undefined) {
        const given = oneOf<FindingCategory>(props['category'], CATEGORIES);
        if (given === undefined) {
          warnings.push({ at, message: `unknown category ${JSON.stringify(props['category'])}, "correctness" used` });
        } else category = given;
      }
      const fixes = Array.isArray(result['fixes']) ? (result['fixes'] as unknown[]) : [];
      const fixEntry = fixes[0];
      const fix = isObj(fixEntry) && isObj(fixEntry['description']) ? str(fixEntry['description']['text']) : undefined;
      const message = messageText ?? title;

      const sizes = sizeErrors(at, { title, message, ...(fix === undefined ? {} : { fix }) });
      if (sizes.length > 0) {
        errors.push(...sizes);
        return;
      }
      findings.push({
        source,
        severity: sarifSeverity(result['level']),
        category,
        file: path.path,
        line,
        title: title.trim(),
        message,
        ...(fix === undefined ? {} : { fix }),
      });
    });
  });

  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, findings, warnings, sources: [...sources] };
}
