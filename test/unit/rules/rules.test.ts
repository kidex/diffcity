// The rules engine (ADR-030): validation, merge order, the user-only kinds,
// rule finding ids and anchoring, and one RuleCheck per configured rule.
// Invented files of a `shopfront` repo.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Symbol } from '../../../src/core/report/types.js';
import { mergeRules, pathMatcher, ruleFindingId, runRules, validateRule, validateRules, type MergedRule, type RuleFile } from '../../../src/core/rules/index.js';

const AT = '2026-05-06T07:08:09.000Z';

function symbol(name: string, start: number, end: number, extra: Partial<Symbol> = {}): Symbol {
  return { id: `src/cart/total.ts#${name}`, name, kind: 'function', status: 'mod', range: { start, end }, ...extra };
}

function file(path: string, extra: Partial<RuleFile> = {}): RuleFile {
  return { path, status: 'mod', symbols: [], after: { bytes: 100, lines: 10 }, ...extra };
}

function ok(rules: MergedRule[]): string[] {
  return rules.map((entry) => (entry.ok ? `${entry.rule.id}:${entry.rule.kind}:${entry.origin}` : `ERR ${entry.ruleId}`));
}

describe('rules/config-validate', () => {
  it('accepts every kind of the ADR-030 shape', () => {
    const rules = [
      { id: 'size', kind: 'file-size', severity: 'med', maxLines: 400, maxBytes: 20000, maxSymbolLines: 60, include: ['src/'], exclude: ['**/*.test.ts'] },
      { id: 'layers-1', kind: 'layers', layers: [['src/ui'], ['src/core']], allowTypeImports: true, aliases: { '@core': 'src/core' }, useTsconfigPaths: false, reportExisting: false },
      { id: 'ci', kind: 'pipeline', severity: 'high', ignoreChecks: ['lint'] },
      { id: 'deps', kind: 'cve', minSeverity: 'moderate', includeDev: false },
    ];
    expect(validateRules(rules).map((entry) => entry.ok)).toEqual([true, true, true, true]);
    expect(validateRules(undefined)).toEqual([]);
  });

  it.each([
    ['a non-object entry', 'size', /must be an object/],
    ['a bad id', { id: 'Size_Limit', kind: 'file-size', maxLines: 1 }, /"id" must match/],
    ['an id over 40 characters', { id: `a${'b'.repeat(40)}`, kind: 'file-size', maxLines: 1 }, /"id" must match/],
    ['an unknown kind', { id: 'size', kind: 'size', maxLines: 1 }, /"kind" must be one of/],
    ['an unknown field', { id: 'size', kind: 'file-size', maxLines: 1, maxFiles: 3 }, /"maxFiles" is not known/],
    ['a bad severity', { id: 'size', kind: 'file-size', maxLines: 1, severity: 'critical' }, /"severity"/],
    ['a zero limit', { id: 'size', kind: 'file-size', maxLines: 0 }, /"maxLines" must be a positive integer/],
    ['a fractional limit', { id: 'size', kind: 'file-size', maxBytes: 1.5 }, /"maxBytes" must be a positive integer/],
    ['no limit at all', { id: 'size', kind: 'file-size' }, /at least one of/],
    ['an empty include entry', { id: 'size', kind: 'file-size', maxLines: 1, include: [''] }, /"include"/],
    ['an include entry over 1,024 characters', { id: 'size', kind: 'file-size', maxLines: 1, include: [`src/${'*a'.repeat(511)}`] }, /"include" entries must be at most 1024 characters/],
    ['an exclude entry over 1,024 characters', { id: 'size', kind: 'file-size', maxLines: 1, exclude: ['x'.repeat(1025)] }, /"exclude" entries must be at most 1024 characters/],
    ['a layers module over 1,024 characters', { id: 'arch', kind: 'layers', layers: [[`pkgs/${'*a'.repeat(510)}`], ['src']] }, /"layers": module ".*" must be at most 1024 characters/],
    ['empty layers', { id: 'arch', kind: 'layers', layers: [] }, /"layers"/],
    ['a severity on cve', { id: 'deps', kind: 'cve', severity: 'high' }, /"severity" is not known/],
    ['a bad cve minSeverity', { id: 'deps', kind: 'cve', minSeverity: 'med' }, /"minSeverity"/],
  ])('rejects %s', (_name, entry, message) => {
    const [validated] = validateRules([entry]);
    expect(validated?.ok).toBe(false);
    if (validated === undefined || validated.ok) throw new Error('unreachable');
    expect(validated.error.message).toMatch(message);
  });

  it('names an entry by its id when it has a valid one, by its place otherwise', () => {
    const named = validateRule({ id: 'size', kind: 'file-size' }, 3);
    const unnamed = validateRule({ kind: 'file-size', maxLines: 1 }, 3);
    expect(named.ok ? null : named.error).toMatchObject({ ruleId: 'size', kind: 'file-size' });
    expect(unnamed.ok ? null : unnamed.error).toMatchObject({ ruleId: 'rules[3]', kind: 'file-size' });
    expect(validateRules({ id: 'size' })).toEqual([{ ok: false, error: { ruleId: 'rules', named: false, kind: null, message: 'field "rules" must be an array' } }]);
  });

  it('matches include and exclude as path prefixes or simple globs, case-sensitively', () => {
    expect(pathMatcher('src/legacy')('src/legacy/old.ts')).toBe(true);
    expect(pathMatcher('src/legacy')('src/Legacy/old.ts')).toBe(false);
    expect(pathMatcher('src/*.ts')('src/cart.ts')).toBe(true);
    expect(pathMatcher('src/*.ts')('src/cart/total.ts')).toBe(false);
    expect(pathMatcher('src/**/*.ts')('src/cart/total.ts')).toBe(true);
    expect(pathMatcher('src/**/*.ts')('src/total.ts')).toBe(true);
    expect(pathMatcher('**/*.test.ts')('test/cart.test.ts')).toBe(true);
    expect(pathMatcher('src/a.b*')('src/aXb.ts')).toBe(false);
  });
});

describe('rules/merge-order', () => {
  it('user rules, then per-repo rules, then the repo config: the same id later replaces it', () => {
    const merged = mergeRules({
      settings: [
        { id: 'size', kind: 'file-size', maxLines: 100 },
        { id: 'ci', kind: 'pipeline' },
      ],
      settingsRepo: [{ id: 'size', kind: 'file-size', maxLines: 200 }],
      repoConfig: [
        { id: 'size', kind: 'file-size', maxLines: 300 },
        { id: 'arch', kind: 'layers', layers: [['src']] },
      ],
    });
    expect(ok(merged)).toEqual(['arch:layers:repo-config', 'ci:pipeline:settings', 'size:file-size:repo-config']);
    const size = merged.find((entry) => entry.ok && entry.rule.id === 'size');
    expect(size?.ok === true && size.rule.kind === 'file-size' ? size.rule.maxLines : null).toBe(300);
  });

  it('a later invalid entry replaces the earlier rule with an error; a duplicate id in one list is an error', () => {
    const merged = mergeRules({
      settings: [{ id: 'size', kind: 'file-size', maxLines: 100 }],
      settingsRepo: [
        { id: 'size', kind: 'file-size', maxLines: -1 },
        { id: 'big', kind: 'file-size', maxBytes: 1 },
        { id: 'big', kind: 'file-size', maxBytes: 2 },
      ],
    });
    expect(merged).toEqual([
      { ok: false, ruleId: 'big', kind: 'file-size', origin: 'settings-repo', reason: 'config-error: settings.json repo rules: rule "big" is defined more than once' },
      { ok: false, ruleId: 'size', kind: 'file-size', origin: 'settings-repo', reason: 'config-error: settings.json repo rules: rule "size": field "maxLines" must be a positive integer' },
    ]);
  });

  it('whole lists that are not arrays stay apart, by origin, and never shadow a rule named "rules"', () => {
    const merged = mergeRules({
      settings: [{ id: 'rules', kind: 'file-size', maxLines: 10 }],
      settingsRepo: 'size',
      repoConfig: { id: 'size' },
    });
    expect(merged.map((entry) => (entry.ok ? `${entry.rule.id}:${entry.origin}` : `${entry.ruleId} ${entry.reason}`))).toEqual([
      'repo-config:rules config-error: diffcity.config.js rules: field "rules" must be an array',
      'rules:settings',
      'settings-repo:rules config-error: settings.json repo rules: field "rules" must be an array',
    ]);
  });

  it('entries with no valid id from two lists stay apart', () => {
    const merged = mergeRules({ settings: [{ kind: 'file-size' }], repoConfig: [{ kind: 'file-size' }] });
    expect(merged.map((entry) => (entry.ok ? entry.rule.id : entry.ruleId))).toEqual(['repo-config:rules[0]', 'settings:rules[0]']);
  });
});

describe('the user-only kinds', () => {
  const repoError = (index: number, kind: 'pipeline' | 'cve'): MergedRule => ({
    ok: false,
    ruleId: `repo-config:rules[${String(index)}]`,
    kind,
    origin: 'repo-config',
    reason: 'config-error: repo config cannot set pipeline or cve rules',
  });

  it('rules/repo-cannot-enable-cve: a cve rule from the repo config is only an error check, never a rule', () => {
    expect(mergeRules({ repoConfig: [{ id: 'size', kind: 'file-size', maxLines: 1 }, { id: 'deps', kind: 'cve' }] }).filter((entry) => !entry.ok)).toEqual([repoError(1, 'cve')]);
    expect(ok(mergeRules({ repoConfig: [{ id: 'deps', kind: 'cve' }] }))).toEqual(['ERR repo-config:rules[0]']);
    // In the user's own lists it is a rule like any other.
    expect(ok(mergeRules({ settingsRepo: [{ id: 'deps', kind: 'cve' }] }))).toEqual(['deps:cve:settings-repo']);
  });

  it('rules/repo-cannot-enable-pipeline: a pipeline rule from the repo config is only an error check, never a rule', () => {
    expect(mergeRules({ repoConfig: [{ id: 'ci', kind: 'pipeline', severity: 'low' }] })).toEqual([repoError(0, 'pipeline')]);
  });

  it('rules/repo-cannot-override-user-cve-keeps-user-rule: the user cve rule stays as configured, the repo entry is a separate error', () => {
    const user = { id: 'deps', kind: 'cve', minSeverity: 'high' };
    for (const repoEntry of [{ id: 'deps', kind: 'cve', minSeverity: 'critical' }, { id: 'deps', kind: 'file-size', maxLines: 1 }, { id: 'deps', kind: 'file-size' }]) {
      const merged = mergeRules({ settings: [user], repoConfig: [{ id: 'size', kind: 'file-size', maxLines: 9 }, repoEntry] });
      expect(merged).toEqual([
        { ok: true, rule: user, origin: 'settings' },
        repoError(1, 'cve'),
        { ok: true, rule: { id: 'size', kind: 'file-size', maxLines: 9 }, origin: 'repo-config' },
      ]);
      const { checks } = runRules(merged, [file('src/cart/total.ts')], AT);
      expect(checks.map((check) => [check.ruleId, check.kind, check.state])).toEqual([
        ['deps', 'cve', 'not-checked'],
        ['repo-config:rules[1]', 'cve', 'error'],
        ['size', 'file-size', 'violations'],
      ]);
    }
  });

  it('rules/repo-cannot-override-user-pipeline-keeps-user-rule: the user pipeline rule stays as configured, the repo entry is a separate error', () => {
    const user = { id: 'ci', kind: 'pipeline', severity: 'high', ignoreChecks: ['lint'] };
    const merged = mergeRules({ settingsRepo: [user], repoConfig: [{ id: 'ci', kind: 'pipeline', ignoreChecks: ['tests', 'lint'] }] });
    expect(merged).toEqual([{ ok: true, rule: user, origin: 'settings-repo' }, repoError(0, 'pipeline')]);
    const overridden = mergeRules({ settings: [user], repoConfig: [{ id: 'ci', kind: 'layers', layers: [['src']] }] });
    expect(overridden).toEqual([{ ok: true, rule: user, origin: 'settings' }, repoError(0, 'pipeline')]);
  });
});

describe('rule findings', () => {
  const rules = mergeRules({ settings: [{ id: 'size', kind: 'file-size', maxSymbolLines: 5, maxLines: 50 }] });

  it('rules/finding-id-stable: rule:<id>:sha256(file + "\\n" + line + "\\n" + title), the same across runs and growth', () => {
    const big = (lines: number): RuleFile => file('src/cart/total.ts', { after: { bytes: 10, lines } });
    const first = runRules(rules, [big(60)], AT).findings;
    const grown = runRules(rules, [big(90)], '2026-06-01T00:00:00.000Z').findings;
    const expected = `rule:size:${createHash('sha256').update('src/cart/total.ts\n0\nFile over 50 lines').digest('hex')}`;
    expect(first.map((finding) => finding.id)).toEqual([expected]);
    expect(grown.map((finding) => finding.id)).toEqual([expected]);
    expect(ruleFindingId('size', 'src/cart/total.ts', 0, 'File over 50 lines')).toBe(expected);
    // The separators keep apart what plain concatenation would merge.
    expect(ruleFindingId('size', 'src/a.ts1', 2, 'Function x over 5 lines')).not.toBe(ruleFindingId('size', 'src/a.ts', 12, 'Function x over 5 lines'));
    expect(first[0]).toMatchObject({ source: 'rule:size', severity: 'low', category: 'style', state: 'open', line: 0, message: 'src/cart/total.ts has 60 lines; the limit is 50 lines.' });
  });

  it('rules/anchor-symbol: a symbol violation anchors to the innermost after-version symbol on its line; a file violation stays at file level', () => {
    const cls = symbol('Cart', 1, 30, { id: 'src/cart/total.ts#Cart', kind: 'class' });
    const method = symbol('Cart.total', 3, 20, { id: 'src/cart/total.ts#Cart.total', kind: 'method' });
    const gone = symbol('legacyTotal', 3, 40, { status: 'del' });
    const { findings } = runRules(rules, [file('src/cart/total.ts', { symbols: [cls, method, gone], after: { bytes: 10, lines: 60 } })], AT);
    expect(findings.map((finding) => [finding.line, finding.title, finding.symbolId])).toEqual([
      [0, 'File over 50 lines', undefined],
      [1, 'Class Cart over 5 lines', 'src/cart/total.ts#Cart'],
      [3, 'Method Cart.total over 5 lines', 'src/cart/total.ts#Cart.total'],
    ]);
    expect(findings[0]).not.toHaveProperty('symbolId');
  });
});

describe('checks', () => {
  it('rules/check-per-rule-in-report: one check per configured rule, sorted by id, with the Report time', () => {
    const merged = mergeRules({
      settings: [
        { id: 'size', kind: 'file-size', maxLines: 5 },
        { id: 'roomy', kind: 'file-size', maxLines: 500 },
        { id: 'ci', kind: 'pipeline' },
      ],
    });
    const { checks, findings } = runRules(merged, [file('src/cart/total.ts'), file('src/cart/tax.ts')], AT);
    expect(checks).toEqual([
      { ruleId: 'ci', kind: 'pipeline', state: 'not-checked', findings: 0, checkedAt: AT },
      { ruleId: 'roomy', kind: 'file-size', state: 'passed', findings: 0, checkedAt: AT },
      { ruleId: 'size', kind: 'file-size', state: 'violations', findings: 2, checkedAt: AT },
    ]);
    expect(findings.map((finding) => finding.file)).toEqual(['src/cart/tax.ts', 'src/cart/total.ts']);
    expect(runRules([], [file('src/cart/total.ts')], AT)).toEqual({ findings: [], checks: [] });
  });

  it('rules/error-state-on-config-error: an invalid rule is an error check with a config-error reason, never dropped or passed', () => {
    const merged = mergeRules({
      settings: [{ id: 'size', kind: 'file-size' }, { id: 'odd', kind: 'weight' }, 7],
      repoConfig: [{ id: 'ci', kind: 'pipeline' }],
    });
    const { checks, findings } = runRules(merged, [file('src/cart/total.ts', { after: { bytes: 1, lines: 9999 } })], AT);
    expect(findings).toEqual([]);
    expect(checks).toEqual([
      { ruleId: 'odd', kind: 'file-size', state: 'error', reason: 'config-error: settings.json rules: rule "odd": field "kind" must be one of file-size, layers, pipeline, cve', findings: 0, checkedAt: AT },
      { ruleId: 'repo-config:rules[0]', kind: 'pipeline', state: 'error', reason: 'config-error: repo config cannot set pipeline or cve rules', findings: 0, checkedAt: AT },
      { ruleId: 'settings:rules[2]', kind: 'file-size', state: 'error', reason: 'config-error: settings.json rules: rules[2] must be an object', findings: 0, checkedAt: AT },
      { ruleId: 'size', kind: 'file-size', state: 'error', reason: 'config-error: settings.json rules: rule "size": needs at least one of maxLines, maxBytes, maxSymbolLines', findings: 0, checkedAt: AT },
    ]);
  });

  it('rules/not-checked-never-passed: kinds this version does not evaluate are not-checked, with no findings', () => {
    const merged = mergeRules({
      settings: [
        { id: 'ci', kind: 'pipeline' },
        { id: 'deps', kind: 'cve' },
      ],
    });
    const { checks } = runRules(merged, [file('src/ui/cart.ts')], AT);
    expect(checks.map((check) => [check.ruleId, check.state])).toEqual([
      ['ci', 'not-checked'],
      ['deps', 'not-checked'],
    ]);
    expect(checks.every((check) => check.state !== 'passed')).toBe(true);
  });
});
