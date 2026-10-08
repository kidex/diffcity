// Rule configuration (ADR-030): the shape of one entry of `rules`, in the user
// settings and in a trusted repo's diffcity.config.js, and its validation.
// Pure: no I/O. An invalid entry is never dropped: it becomes a RuleError that
// the engine turns into a RuleCheck with state `error`.

import type { RuleCheck } from '../report/types.js';

export type Severity = 'high' | 'med' | 'low';
export type RuleKind = RuleCheck['kind'];

export interface FileSizeRule {
  id: string;
  kind: 'file-size';
  severity?: Severity;
  maxLines?: number;
  maxBytes?: number;
  maxSymbolLines?: number;
  include?: string[];
  exclude?: string[];
}

/** ADR-031; validated now, evaluated by the layers rule. */
export interface LayersRule {
  id: string;
  kind: 'layers';
  severity?: Severity;
  layers: string[][];
  allowTypeImports?: boolean;
  aliases?: Record<string, string>;
  useTsconfigPaths?: boolean;
  reportExisting?: boolean;
}

/** User settings only. */
export interface PipelineRule {
  id: string;
  kind: 'pipeline';
  severity?: Severity;
  ignoreChecks?: string[];
}

/** User settings only. */
export interface CveRule {
  id: string;
  kind: 'cve';
  minSeverity?: 'low' | 'moderate' | 'high' | 'critical';
  includeDev?: boolean;
}

export type RuleConfig = FileSizeRule | LayersRule | PipelineRule | CveRule;

/** Where a list of rules comes from, in merge order (ADR-030). */
export type RuleOrigin = 'settings' | 'settings-repo' | 'repo-config';

/** How an origin is named in a `config-error: …` reason. No absolute path: the Report may leave the machine. */
export const ORIGIN_LABEL: Record<RuleOrigin, string> = {
  settings: 'settings.json rules',
  'settings-repo': 'settings.json repo rules',
  'repo-config': 'diffcity.config.js rules',
};

/** An entry that could not be accepted. */
export interface RuleError {
  /** The entry's id when it has a valid one; otherwise `rules[<index>]`, or `rules` for the whole list. */
  ruleId: string;
  /** Whether ruleId is the entry's own id; when false it names a place, which the merge qualifies by origin. */
  named: boolean;
  /** The entry's kind when it is a known one; null otherwise. */
  kind: RuleKind | null;
  /** Plain English, without the `config-error: ` prefix. */
  message: string;
}

export type ValidatedEntry = { ok: true; rule: RuleConfig } | { ok: false; error: RuleError };

export const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RULE_KINDS: readonly RuleKind[] = ['file-size', 'layers', 'pipeline', 'cve'];
const SEVERITIES: readonly Severity[] = ['high', 'med', 'low'];
const CVE_SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;

const FIELDS: Record<RuleKind, readonly string[]> = {
  'file-size': ['id', 'kind', 'severity', 'maxLines', 'maxBytes', 'maxSymbolLines', 'include', 'exclude'],
  layers: ['id', 'kind', 'severity', 'layers', 'allowTypeImports', 'aliases', 'useTsconfigPaths', 'reportExisting'],
  pipeline: ['id', 'kind', 'severity', 'ignoreChecks'],
  cve: ['id', 'kind', 'minSeverity', 'includeDev'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isStringArray(value: unknown, nonEmpty: boolean): value is string[] {
  return Array.isArray(value) && (value as unknown[]).every((entry) => typeof entry === 'string' && (!nonEmpty || entry !== ''));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The first problem of a known kind's fields, or null. */
function fieldProblem(kind: RuleKind, entry: Record<string, unknown>): string | null {
  for (const key of Object.keys(entry)) {
    if (!FIELDS[kind].includes(key)) return `field "${key}" is not known for kind "${kind}" (allowed: ${FIELDS[kind].join(', ')})`;
  }
  if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity as Severity)) {
    return 'field "severity" must be one of high, med, low';
  }
  switch (kind) {
    case 'file-size': {
      const limits = ['maxLines', 'maxBytes', 'maxSymbolLines'] as const;
      for (const limit of limits) {
        if (entry[limit] !== undefined && !isPositiveInteger(entry[limit])) return `field "${limit}" must be a positive integer`;
      }
      if (limits.every((limit) => entry[limit] === undefined)) return 'needs at least one of maxLines, maxBytes, maxSymbolLines';
      for (const list of ['include', 'exclude'] as const) {
        if (entry[list] !== undefined && !isStringArray(entry[list], true)) return `field "${list}" must be an array of non-empty strings`;
      }
      return null;
    }
    case 'layers': {
      const { layers, aliases } = entry;
      if (!Array.isArray(layers) || layers.length === 0 || !(layers as unknown[]).every((layer) => isStringArray(layer, true) && layer.length > 0)) {
        return 'field "layers" must be a non-empty array of non-empty arrays of non-empty strings';
      }
      for (const flag of ['allowTypeImports', 'useTsconfigPaths', 'reportExisting'] as const) {
        if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') return `field "${flag}" must be a boolean`;
      }
      if (aliases !== undefined && (!isPlainObject(aliases) || !Object.values(aliases).every((target) => typeof target === 'string'))) {
        return 'field "aliases" must be an object of strings';
      }
      return null;
    }
    case 'pipeline':
      if (entry.ignoreChecks !== undefined && !isStringArray(entry.ignoreChecks, true)) return 'field "ignoreChecks" must be an array of non-empty strings';
      return null;
    case 'cve':
      if (entry.minSeverity !== undefined && !(CVE_SEVERITIES as readonly unknown[]).includes(entry.minSeverity)) {
        return 'field "minSeverity" must be one of low, moderate, high, critical';
      }
      if (entry.includeDev !== undefined && typeof entry.includeDev !== 'boolean') return 'field "includeDev" must be a boolean';
      return null;
  }
}

/** A deep copy of the accepted fields, so a config module cannot change a rule after validation. */
function copyRule(entry: Record<string, unknown>): RuleConfig {
  return JSON.parse(JSON.stringify(entry)) as RuleConfig;
}

/** Validates one entry of a `rules` list. Pure. */
export function validateRule(value: unknown, index: number): ValidatedEntry {
  const fallbackId = `rules[${String(index)}]`;
  if (!isPlainObject(value)) return { ok: false, error: { ruleId: fallbackId, named: false, kind: null, message: `${fallbackId} must be an object` } };
  const id = typeof value.id === 'string' && RULE_ID_PATTERN.test(value.id) ? value.id : null;
  const kind = RULE_KINDS.includes(value.kind as RuleKind) ? (value.kind as RuleKind) : null;
  const ruleId = id ?? fallbackId;
  const fail = (message: string): ValidatedEntry => ({ ok: false, error: { ruleId, named: id !== null, kind, message } });
  if (id === null) return fail(`${fallbackId}: field "id" must match ${RULE_ID_PATTERN.source}`);
  if (kind === null) return fail(`rule "${id}": field "kind" must be one of ${RULE_KINDS.join(', ')}`);
  const problem = fieldProblem(kind, value);
  if (problem !== null) return fail(`rule "${id}": ${problem}`);
  return { ok: true, rule: copyRule(value) };
}

/**
 * Validates a `rules` value: absent is no rules; anything but an array is one
 * error for the whole list (ruleId `rules`), since no entry can be told apart.
 */
export function validateRules(value: unknown): ValidatedEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ ok: false, error: { ruleId: 'rules', named: false, kind: null, message: 'field "rules" must be an array' } }];
  return (value as unknown[]).map((entry, index) => validateRule(entry, index));
}

// ---------- include / exclude ----------

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        // `**/` also matches no directory at all.
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether a repo-relative path matches one include/exclude entry (ADR-030): a
 * pattern with `*` is a glob over the whole path (`*` within a segment, `**`
 * across segments); any other pattern is a path prefix. Case-sensitive.
 */
export function pathMatcher(pattern: string): (path: string) => boolean {
  if (!pattern.includes('*')) return (path) => path.startsWith(pattern);
  const regexp = globToRegExp(pattern);
  return (path) => regexp.test(path);
}

/** A file's scope test from `include` (all files when absent) and `exclude`. */
export function scopeOf(include: readonly string[] | undefined, exclude: readonly string[] | undefined): (path: string) => boolean {
  const included = include?.map(pathMatcher);
  const excluded = (exclude ?? []).map(pathMatcher);
  return (path) => (included === undefined || included.some((match) => match(path))) && !excluded.some((match) => match(path));
}
