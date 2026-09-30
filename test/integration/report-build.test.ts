// buildReport (ADR-011) over temp repos built from test/fixtures/report/* and spec/*.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config/index.js';
import { buildReport } from '../../src/core/report/build.js';
import type { File, Report, Status, Verdict } from '../../src/core/report/types.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { fixtureFile, repoFromFixture, type FixtureRepo, type FixtureRepoOptions } from '../helpers/fixture-repo.js';

isolateGitConfig();

const opened: FixtureRepo[] = [];

async function fixtureRepo(name: string, options?: FixtureRepoOptions): Promise<FixtureRepo> {
  const fixture = await repoFromFixture(name, options);
  opened.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.repo.cleanup();
});

const NOW = new Date('2026-03-04T05:06:07.000Z');

function build(repoDir: string, extra: { base?: string; head?: string } = {}): Promise<Report> {
  return buildReport({ repoDir, now: NOW, runner: ghForbidden().runner, ...extra });
}

/** One repo and one report shared by every test of the enclosing describe. */
function sharedReport(name: string, options?: FixtureRepoOptions): () => Report {
  let fixture: FixtureRepo | undefined;
  let report: Report | undefined;
  beforeAll(async () => {
    fixture = await repoFromFixture(name, options);
    report = await build(fixture.repo.dir);
  });
  afterAll(async () => {
    await fixture?.repo.cleanup();
  });
  return () => {
    if (report === undefined) throw new Error(`report for ${name} was not built`);
    return report;
  };
}

function allFiles(report: Report): File[] {
  return report.packages.flatMap((pkg) => pkg.files);
}

function file(report: Report, path: string): File {
  const found = allFiles(report).find((f) => f.path === path);
  if (found === undefined) throw new Error(`no file ${path} in report`);
  return found;
}

function symbolStatuses(f: File): Record<string, Status> {
  return Object.fromEntries(f.symbols.map((s) => [s.id, s.status]));
}

describe('report/package-by-directory', () => {
  const shared = sharedReport('report/package-by-directory');

  it('groups files by parent directory, root is ".", tier 1 from the package path', () => {
    const report = shared();
    expect(report.packages.map((pkg) => [pkg.id, pkg.path, pkg.tier1])).toEqual([
      ['.', '.', false],
      ['src/billing', 'src/billing', true],
      ['src/orders', 'src/orders', false],
      ['src/orders/lines', 'src/orders/lines', false],
    ]);
    expect(report.packages.map((pkg) => pkg.files.map((f) => f.path))).toEqual([
      ['index.ts'],
      ['src/billing/invoice.ts'],
      ['src/orders/cart.ts'],
      ['src/orders/lines/line.ts'],
    ]);
  });

  it('file id is the path, symbol id is path#qualifiedName', () => {
    const report = shared();
    for (const f of allFiles(report)) {
      expect(f.id).toBe(f.path);
      for (const s of f.symbols) expect(s.id).toBe(`${f.path}#${s.name}`);
    }
    expect(file(report, 'src/orders/cart.ts').symbols.map((s) => s.id)).toEqual(['src/orders/cart.ts#addItem']);
  });

  it('a file in a tier 1 package is eyes; the others are ok or same', () => {
    const report = shared();
    expect(allFiles(report).map((f) => [f.path, f.status, f.verdict])).toEqual([
      ['index.ts', 'mod', 'ok'],
      ['src/billing/invoice.ts', 'mod', 'eyes'],
      ['src/orders/cart.ts', 'mod', 'ok'],
      ['src/orders/lines/line.ts', 'same', 'same'],
    ]);
  });
});

describe('report/untouched-files-included', () => {
  it('includes untouched supported files as same with their symbols; unsupported untouched files are left out', async () => {
    const { repo } = await fixtureRepo('report/untouched-files-included');
    const report = await build(repo.dir);
    expect(allFiles(report).map((f) => [f.path, f.language, f.status, f.verdict])).toEqual([
      ['db/stock.sql', 'sql', 'same', 'same'],
      ['docs/recipes.md', 'other', 'mod', 'ok'],
      ['src/pantry/jar.ts', 'typescript', 'same', 'same'],
      ['src/pantry/shelf.ts', 'typescript', 'mod', 'ok'],
    ]);
    expect(symbolStatuses(file(report, 'src/pantry/jar.ts'))).toEqual({
      'src/pantry/jar.ts#openJar': 'same',
      'src/pantry/jar.ts#Jar': 'same',
      'src/pantry/jar.ts#Jar.fill': 'same',
    });
    expect(symbolStatuses(file(report, 'db/stock.sql'))).toEqual({
      'db/stock.sql#CREATE TABLE stock': 'same',
      'db/stock.sql#CREATE INDEX stock_grams_idx': 'same',
    });
    expect(file(report, 'docs/recipes.md').symbols).toEqual([]);
  });

  it('also includes untouched files when the change is in the working tree', async () => {
    const { repo } = await fixtureRepo('report/untouched-files-included', { commit: false });
    const report = await build(repo.dir);
    expect(allFiles(report).map((f) => [f.path, f.status])).toEqual([
      ['db/stock.sql', 'same'],
      ['docs/recipes.md', 'mod'],
      ['src/pantry/jar.ts', 'same'],
      ['src/pantry/shelf.ts', 'mod'],
    ]);
  });
});

describe('report/ids-stable', () => {
  it('the same symbol keeps the same id across two heads', async () => {
    const fixture = await fixtureRepo('report/ids-stable');
    const first = await fixture.repo.head();
    const second = await fixture.apply('later');
    if (second === null) throw new Error('later stage was not committed');

    const atFirst = await build(fixture.repo.dir, { head: first });
    const atSecond = await build(fixture.repo.dir, { head: second });
    const dish = 'src/menu/dish.ts';

    expect(symbolStatuses(file(atFirst, dish))).toEqual({
      [`${dish}#season`]: 'add',
      [`${dish}#plate`]: 'same',
      [`${dish}#garnish`]: 'mod',
    });
    expect(symbolStatuses(file(atSecond, dish))).toEqual({
      [`${dish}#season`]: 'add',
      [`${dish}#plate`]: 'sig',
      [`${dish}#garnish`]: 'mod',
    });
    expect(atFirst.meta.head).toBe(first);
    expect(atSecond.meta.head).toBe(second);
  });
});

describe('report/summary-counts', () => {
  const shared = sharedReport('report/summary-counts');
  const expectedSummary: Report['summary'] = {
    files: 7,
    byStatus: { add: 2, mod: 2, sig: 1, del: 1, same: 3 },
    byVerdict: { eyes: 2, risky: 0, spec: 0, ok: 3, same: 2 },
    tier1Files: ['src/billing/rates.ts'],
  };

  it('counts symbols by status and files by verdict; tier1Files lists touched tier 1 files only', () => {
    const report = shared();
    expect(allFiles(report).map((f) => [f.path, f.status, f.verdict])).toEqual([
      ['src/billing/rates.ts', 'mod', 'eyes'],
      ['src/billing/tax.ts', 'same', 'same'],
      ['src/kitchen/fresh.ts', 'add', 'ok'],
      ['src/kitchen/old.ts', 'del', 'ok'],
      ['src/kitchen/oven.ts', 'sig', 'eyes'],
      ['src/kitchen/tidy.ts', 'same', 'same'],
      ['src/kitchen/timer.ts', 'add', 'ok'],
    ]);
    expect(report.summary).toEqual(expectedSummary);
  });

  it('gives the same counts for the uncommitted working tree (untracked new file included)', async () => {
    const { repo } = await fixtureRepo('report/summary-counts', { commit: false });
    const report = await build(repo.dir);
    expect(report.summary).toEqual(expectedSummary);
    expect(report.meta.commits).toBe(0);
  });

  it('keeps every status and verdict key, zeros included, in a fixed order', () => {
    const report = shared();
    expect(Object.keys(report.summary.byStatus)).toEqual(['add', 'mod', 'sig', 'del', 'same'] satisfies Status[]);
    expect(Object.keys(report.summary.byVerdict)).toEqual(['eyes', 'risky', 'spec', 'ok', 'same'] satisfies Verdict[]);
  });

  it('has the phase 1 constants and meta', () => {
    const report = shared();
    expect(report.steps).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.meta).toMatchObject({ base: 'main', head: 'feature/work', commits: 1, generatedAt: NOW.toISOString() });
  });
});

describe('report/deterministic', () => {
  it('two runs with the same now give identical JSON', async () => {
    const { repo } = await fixtureRepo('report/deterministic', { commit: false });
    const first = JSON.stringify(await build(repo.dir));
    const second = JSON.stringify(await build(repo.dir));
    expect(second).toBe(first);
  });

  it('orders packages and files by path (code unit order) and symbols by range start', async () => {
    const { repo } = await fixtureRepo('report/deterministic');
    const report = await build(repo.dir);
    expect(report.packages.map((pkg) => pkg.path)).toEqual(['.', 'Upper', 'alpha', 'alpha/beta', 'zeta']);
    expect(allFiles(report).map((f) => f.path)).toEqual([
      'root.ts',
      'Upper/case.ts',
      'alpha/a.ts',
      'alpha/b.ts',
      'alpha/beta/deep.ts',
      'zeta/gone.ts',
      'zeta/last.ts',
    ]);
    for (const f of allFiles(report)) {
      const starts = f.symbols.map((s) => s.range.start);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    }
    expect(file(report, 'alpha/b.ts').symbols.map((s) => [s.name, s.status])).toEqual([
      ['bee', 'mod'],
      ['wasp', 'add'],
    ]);
  });
});

describe('spec (phase 1: ADR-010)', () => {
  it('X3 spec/absent: no spec, inSpec is null everywhere', async () => {
    const { repo } = await fixtureRepo('spec/absent');
    const report = await build(repo.dir);
    expect(allFiles(report).length).toBe(2);
    expect(allFiles(report).map((f) => f.inSpec)).toEqual([null, null]);
    expect(report.summary.byVerdict.spec).toBe(0);
  });

  it('spec/present-phase1: with .diffcity/spec.md present, inSpec is still null', async () => {
    const spec = fixtureFile('spec/present-phase1', 'spec.md');
    const { repo } = await fixtureRepo('spec/present-phase1', { extra: { '.diffcity/spec.md': spec } });
    const report = await build(repo.dir);
    expect(allFiles(report).map((f) => [f.path, f.status, f.inSpec])).toEqual([
      ['src/garden/bed.ts', 'mod', null],
      ['src/garden/fence.ts', 'same', null],
      ['src/garden/shed.ts', 'add', null],
    ]);
    expect(report.summary.byVerdict.spec).toBe(0);
  });
});

describe('config', () => {
  it('tier 1 tokens from diffcity.config.js drive file and package tier 1', async () => {
    const { repo } = await fixtureRepo('report/package-by-directory');
    await writeFile(join(repo.dir, 'diffcity.config.js'), "export default { tier1: ['orders'] };\n", 'utf8');
    const report = await build(repo.dir);
    expect(report.packages.filter((pkg) => pkg.tier1).map((pkg) => pkg.path)).toEqual(['src/orders', 'src/orders/lines']);
    expect(report.summary.tier1Files).toEqual(['src/orders/cart.ts']);
    expect(file(report, 'src/billing/invoice.ts').verdict).toBe('ok');
  });

  it('a tier1 function that throws is a ConfigError naming the field', async () => {
    const { repo } = await fixtureRepo('report/package-by-directory');
    await writeFile(
      join(repo.dir, 'diffcity.config.js'),
      "export default { tier1: () => { throw new Error('nope'); } };\n",
      'utf8',
    );
    const error: unknown = await build(repo.dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).field).toBe('tier1');
  });

  it('--base overrides the config base', async () => {
    const { repo } = await fixtureRepo('report/package-by-directory');
    await repo.git('branch', 'trunk', 'main');
    await writeFile(join(repo.dir, 'diffcity.config.js'), "export default { base: 'missing-branch' };\n", 'utf8');
    const report = await build(repo.dir, { base: 'trunk' });
    expect(report.meta.base).toBe('trunk');
  });
});

describe('report/untouched-binary-skipped', () => {
  it.each([
    ['committed', true],
    ['working tree', false],
  ])('%s: an untouched binary file with a code extension is same with no symbols', async (_mode, commit) => {
    const { repo } = await fixtureRepo('report/untouched-binary-skipped', { commit });
    const report = await build(repo.dir);
    expect(allFiles(report).map((f) => [f.path, f.language, f.status, f.verdict, f.symbols.length])).toEqual([
      ['media/clip.ts', 'typescript', 'same', 'same', 0],
      ['src/player/play.ts', 'typescript', 'mod', 'ok', 1],
    ]);
  });
});
