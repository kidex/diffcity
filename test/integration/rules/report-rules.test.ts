// Rules in buildReport (ADR-030) over temp repos of invented projects: rule
// findings and checks in the Report, the verdicts they drive, the trust gate
// on a repo config's rules, and the content hash.

import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, type BuildReportOptions } from '../../../src/core/report/build.js';
import { contentHashOf } from '../../../src/core/report/snapshot.js';
import type { File, Report } from '../../../src/core/report/types.js';
import type { UserRuleSettings } from '../../../src/core/settings/index.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type FileTree, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const NOW = new Date('2026-04-05T06:07:08.000Z');

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`).join('\n') + '\n';
}

/** `count` statements inside one function, so its range spans count + 2 lines. */
function longFunction(name: string, count: number): string {
  return [`export function ${name}(amount: number): number {`, ...Array.from({ length: count }, (_, i) => `  amount += ${String(i)};`), '  return amount;', '}', ''].join('\n');
}

/** A repo on `main` with `before`, and a `feature` branch with `after` committed (or left in the working tree). */
async function repoWith(name: string, before: FileTree, after: FileTree, options: { dirty?: boolean } = {}): Promise<TempRepo> {
  const repo = await createRepo({ name, files: before });
  repos.push(repo);
  await repo.branch('feature');
  if (options.dirty === true) await repo.write(after);
  else await repo.commit('feature work', after);
  return repo;
}

function build(repo: TempRepo, extra: Partial<BuildReportOptions> = {}): Promise<Report> {
  return buildReport({ repoDir: repo.dir, base: 'main', now: NOW, runner: ghForbidden().runner, trustConfig: true, ...extra });
}

function fileOf(report: Report, path: string): File {
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is not in the report`);
  return file;
}

const user = (rules: unknown[]): UserRuleSettings => ({ settings: rules });

describe('rules in the Report', () => {
  it('rules/high-makes-risky: an open high rule finding makes its file risky; tier 1 stays eyes; low stays ok', async () => {
    const repo = await repoWith(
      'shopfront',
      { 'src/cart/total.ts': 'export const total = 1;\n', 'src/auth/login.ts': 'export const login = 1;\n', 'src/cart/tax.ts': 'export const tax = 1;\n' },
      { 'src/cart/total.ts': lines(30, '// total'), 'src/auth/login.ts': lines(30, '// login'), 'src/cart/tax.ts': lines(5, '// tax') },
    );
    const report = await build(repo, {
      userRules: user([
        { id: 'size', kind: 'file-size', severity: 'high', maxLines: 20 },
        { id: 'tiny', kind: 'file-size', maxLines: 3, include: ['src/cart/tax.ts'] },
      ]),
    });
    expect(fileOf(report, 'src/cart/total.ts').verdict).toBe('risky');
    expect(fileOf(report, 'src/auth/login.ts').verdict).toBe('eyes');
    // A low finding never changes a verdict.
    expect(fileOf(report, 'src/cart/tax.ts').verdict).toBe('ok');
    expect(report.summary.byVerdict).toEqual({ eyes: 1, risky: 1, spec: 0, ok: 1, same: 0 });
    expect(report.findings.map((finding) => [finding.source, finding.file, finding.severity])).toEqual([
      ['rule:size', 'src/auth/login.ts', 'high'],
      ['rule:tiny', 'src/cart/tax.ts', 'low'],
      ['rule:size', 'src/cart/total.ts', 'high'],
    ]);
  });

  it('rules/check-per-rule-in-report: checks with the Report time, symbol findings anchored, untouched files skipped', async () => {
    const repo = await repoWith(
      'ledger',
      { 'src/ledger/post.ts': longFunction('postEntry', 2), 'src/ledger/old.ts': longFunction('oldEntry', 40) },
      { 'src/ledger/post.ts': longFunction('postEntry', 12) },
    );
    const report = await build(repo, { userRules: user([{ id: 'fn-size', kind: 'file-size', maxSymbolLines: 10 }, { id: 'ci', kind: 'pipeline' }]) });
    expect(report.checks).toEqual([
      { ruleId: 'ci', kind: 'pipeline', state: 'not-checked', findings: 0, checkedAt: NOW.toISOString() },
      { ruleId: 'fn-size', kind: 'file-size', state: 'violations', findings: 1, checkedAt: NOW.toISOString() },
    ]);
    const [finding] = report.findings;
    const symbol = fileOf(report, 'src/ledger/post.ts').symbols.find((candidate) => candidate.name === 'postEntry');
    expect(finding).toMatchObject({ file: 'src/ledger/post.ts', line: 1, title: 'Function postEntry over 10 lines', symbolId: symbol?.id });
    expect(report.findings).toHaveLength(1);
  });

  it('measures files that are not parsed (text and binary), committed and in the working tree', async () => {
    const before = { 'docs/guide.md': 'start\n', 'assets/logo.bin': 'x' };
    const after = { 'docs/guide.md': lines(12), 'assets/logo.bin': `${'\0'.repeat(10)}${'z\n'.repeat(50)}` };
    const rules = user([{ id: 'size', kind: 'file-size', maxLines: 10, maxBytes: 100 }]);
    for (const dirty of [false, true]) {
      const repo = await repoWith('acme-cli', before, after, { dirty });
      const report = await build(repo, { userRules: rules });
      expect(report.findings.map((finding) => [finding.file, finding.title])).toEqual([
        ['assets/logo.bin', 'File over 100 bytes'],
        ['docs/guide.md', 'File over 10 lines'],
      ]);
    }
  });

  it('rules/untrusted-repo-rules-ignored: the repo config rules apply only when the repo is trusted; user rules always do', async () => {
    const config = `export default { rules: [{ id: 'repo-size', kind: 'file-size', maxLines: 2 }] };\n`;
    const repo = await repoWith('acme-cli', { 'diffcity.config.js': config, 'src/cli.ts': 'export const a = 1;\n' }, { 'src/cli.ts': lines(5, '//') });
    const userRules = user([{ id: 'user-size', kind: 'file-size', maxLines: 100 }]);
    const trusted = await build(repo, { userRules });
    const untrusted = await build(repo, { userRules, trustConfig: false });
    expect(trusted.checks?.map((check) => [check.ruleId, check.state])).toEqual([
      ['repo-size', 'violations'],
      ['user-size', 'passed'],
    ]);
    expect(untrusted.checks?.map((check) => [check.ruleId, check.state])).toEqual([['user-size', 'passed']]);
    expect(untrusted.findings).toEqual([]);
  });

  it('rules/error-state-on-config-error: a repo config pipeline rule and a broken rule are error checks', async () => {
    const config = `export default { rules: [{ id: 'ci', kind: 'pipeline' }, { id: 'size', kind: 'file-size', maxLines: 'many' }] };\n`;
    const repo = await repoWith('shopfront', { 'diffcity.config.js': config, 'src/a.ts': 'export const a = 1;\n' }, { 'src/a.ts': 'export const a = 2;\n' });
    const report = await build(repo);
    expect(report.checks?.map((check) => [check.ruleId, check.state, check.reason])).toEqual([
      ['repo-config:rules[0]', 'error', 'config-error: repo config cannot set pipeline or cve rules'],
      ['size', 'error', 'config-error: diffcity.config.js rules: rule "size": field "maxLines" must be a positive integer'],
    ]);
  });

  it('is deterministic and keeps the content hash apart from the time; a Report without rules has no checks', async () => {
    const repo = await repoWith('ledger', { 'src/a.ts': 'export const a = 1;\n' }, { 'src/a.ts': lines(9, '//'), 'src/b.ts': lines(9, '//') });
    const userRules = user([{ id: 'size', kind: 'file-size', maxLines: 5 }]);
    const first = await build(repo, { userRules });
    const later = await build(repo, { userRules, now: new Date('2026-09-09T09:09:09.000Z') });
    expect(later.checks?.[0]?.checkedAt).toBe('2026-09-09T09:09:09.000Z');
    expect(contentHashOf(later)).toBe(contentHashOf(first));
    expect(JSON.stringify({ ...later, meta: first.meta, checks: first.checks })).toBe(JSON.stringify(first));
    const without = await build(repo);
    expect(without).not.toHaveProperty('checks');
    expect(without.findings).toEqual([]);
    expect(contentHashOf(without)).not.toBe(contentHashOf(first));
  });
});
