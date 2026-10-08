// The layers rule (ADR-031) in buildReport, over temp git repos built from
// test/fixtures/rules/layers/: imports from the parse trees, the snapshot's
// file lists, renames as git detects them, tsconfig.json read from the after
// state through git, the working tree, and the content hash.

import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, type BuildReportOptions } from '../../../src/core/report/build.js';
import { contentHashOf } from '../../../src/core/report/snapshot.js';
import type { File, Report } from '../../../src/core/report/types.js';
import { repoFromFixture, type FixtureRepo } from '../../helpers/fixture-repo.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import { findingRows, LAYERS_CASES, layersRule } from '../../helpers/layers-case.js';

isolateGitConfig();

const fixtures: FixtureRepo[] = [];
afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.repo.cleanup();
});

const NOW = new Date('2026-04-05T06:07:08.000Z');
const UPWARD_DAEMON = 'Upward import: src/core → src/daemon';

async function fixture(name: string, options: { commit?: boolean } = {}): Promise<FixtureRepo> {
  const repo = await repoFromFixture(`${LAYERS_CASES}/${name}`, options);
  fixtures.push(repo);
  return repo;
}

function build(fixtureRepo: FixtureRepo, rules: unknown[] | null, extra: Partial<BuildReportOptions> = {}): Promise<Report> {
  return buildReport({
    repoDir: fixtureRepo.repo.dir,
    base: 'main',
    now: NOW,
    runner: ghForbidden().runner,
    trustConfig: true,
    ...(rules === null ? {} : { userRules: { settings: rules } }),
    ...extra,
  });
}

function fileOf(report: Report, path: string): File {
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`${path} is not in the report`);
  return file;
}

describe('the layers rule in the Report', () => {
  it('reports a new upward import as a med architecture finding; the check carries the Report time', async () => {
    const repo = await fixture('upward-violation');
    const report = await build(repo, [layersRule('upward-violation')]);
    expect(findingRows(report.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
    expect(report.findings[0]).toMatchObject({ source: 'rule:layers', severity: 'med', category: 'architecture', state: 'open' });
    expect(report.findings[0]).not.toHaveProperty('symbolId');
    expect(report.checks).toEqual([{ ruleId: 'layers', kind: 'layers', state: 'violations', findings: 1, checkedAt: NOW.toISOString() }]);
    // A med finding does not change the verdict (SPEC.md 5.2); a high one makes the file risky.
    expect(fileOf(report, 'src/core/ledger.ts').verdict).toBe('ok');
    const high = await build(repo, [layersRule('upward-violation', { severity: 'high' })]);
    expect(fileOf(high, 'src/core/ledger.ts').verdict).toBe('risky');
  });

  it('compares a file git saw renamed with its old path', async () => {
    const repo = await fixture('renamed-file-compares-old-path');
    const report = await build(repo, [layersRule('renamed-file-compares-old-path')]);
    expect(findingRows(report.findings)).toEqual([['src/core/books/ledger.ts', 2, 'Upward import: src/core → src/ui']]);
  });

  it('reads compilerOptions.paths from the after tree through git', async () => {
    const repo = await fixture('tsconfig-paths-star');
    const report = await build(repo, [layersRule('tsconfig-paths-star')]);
    expect(findingRows(report.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('checks a working tree change, new edges only, and counts unresolved imports', async () => {
    const edges = await fixture('only-new-edges', { commit: false });
    expect(findingRows((await build(edges, [layersRule('only-new-edges')])).findings)).toEqual([['src/core/ledger.ts', 3, 'Upward import: src/core → src/cli']]);
    const counted = await fixture('check-reason-counts-unresolved', { commit: false });
    const report = await build(counted, [layersRule('check-reason-counts-unresolved')]);
    expect(report.checks?.map((check) => [check.state, check.reason])).toEqual([['violations', '3 imports could not be resolved']]);
  });

  it('a config error is an error check, never passed', async () => {
    const repo = await fixture('config-overlap-error');
    const report = await build(repo, [layersRule('config-overlap-error')]);
    expect(report.findings).toEqual([]);
    expect(report.checks?.map((check) => [check.state, check.reason])).toEqual([
      ['error', 'config-error: settings.json rules: rule "layers": field "layers": modules "packages/*/src" and "packages/billing/src" overlap and are not nested'],
    ]);
  });

  it('says in the reason what it could not check: a binary code file, a missing or broken tsconfig.json', async () => {
    const repo = await fixture('upward-violation');
    // NUL bytes: git and the report treat it as binary, so it is never parsed.
    await repo.repo.commit('binary', { 'src/core/blob.ts': `export const blob = 1;\n${'\0'.repeat(16)}\n` });
    const report = await build(repo, [layersRule('upward-violation', { useTsconfigPaths: true })]);
    expect(report.checks?.map((check) => [check.state, check.reason])).toEqual([['violations', '1 file could not be parsed; tsconfig.json not found']]);
    const broken = await fixture('tsconfig-unparsable-noted');
    const brokenReport = await build(broken, [layersRule('tsconfig-unparsable-noted')]);
    expect(brokenReport.checks?.map((check) => [check.state, check.reason])).toEqual([['violations', 'tsconfig.json could not be parsed']]);
  });

  it('is deterministic, keeps the time out of the content hash, and leaves a Report without the rule as it was', async () => {
    const repo = await fixture('js-to-ts-sibling');
    const rules = [layersRule('js-to-ts-sibling')];
    const first = await build(repo, rules);
    const later = await build(repo, rules, { now: new Date('2026-09-09T09:09:09.000Z') });
    expect(first.findings).toHaveLength(2);
    expect(contentHashOf(later)).toBe(contentHashOf(first));
    expect(JSON.stringify({ ...later, meta: first.meta, checks: first.checks })).toBe(JSON.stringify(first));
    const without = await build(repo, null);
    expect(without).not.toHaveProperty('checks');
    expect(without.findings).toEqual([]);
    // Without the rule, the Report is the one the rule's findings and check are added to.
    expect(JSON.stringify(without)).toBe(JSON.stringify({ ...first, findings: [], checks: undefined, summary: without.summary }));
  });
});
