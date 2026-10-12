// Spec scope end to end (SPEC.md 5.5, ADR-035): `.diffcity/spec.md` read from
// the head tree or, for a dirty change, the working tree; `--spec <file>`
// from disk taking precedence; a spec above 256 KiB counting as absent with
// a notice; no spec at all leaving the Report as it was.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runDiff } from '../../../src/cli/diff.js';
import { buildReport, type BuildReportOptions } from '../../../src/core/report/build.js';
import type { Report } from '../../../src/core/report/types.js';
import { MAX_SPEC_BYTES, readSpecFile, TOO_LARGE_NOTICE } from '../../../src/core/spec/index.js';
import { fixtureFile, repoFromFixture, type FixtureRepo, type FixtureRepoOptions } from '../../helpers/fixture-repo.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';

isolateGitConfig();

const NOW = new Date('2026-10-09T08:00:00.000Z');
const cliEntry = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));

const opened: FixtureRepo[] = [];
const dirs: string[] = [];

async function fixtureRepo(name: string, options?: FixtureRepoOptions): Promise<FixtureRepo> {
  const fixture = await repoFromFixture(name, options);
  opened.push(fixture);
  return fixture;
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diffcity-spec-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.repo.cleanup();
  while (dirs.length > 0) await rm(dirs.pop() ?? '', { recursive: true, force: true });
});

function build(repoDir: string, extra: Partial<BuildReportOptions> = {}): Promise<Report> {
  return buildReport({ repoDir, now: NOW, runner: ghForbidden().runner, trustConfig: true, ...extra });
}

function inSpec(report: Report): Record<string, boolean | null> {
  return Object.fromEntries(report.packages.flatMap((pkg) => pkg.files.map((file) => [file.path, file.inSpec])));
}

/** A spec of exactly `bytes` bytes that names `bake`. */
function specOfSize(bytes: number): string {
  const head = 'Bake longer in `bake`.\n';
  return head + 'x'.repeat(bytes - head.length);
}

const BAKE_IN = { 'src/bakery/oven.ts': true, 'src/bakery/till.ts': false };
const NONE = { 'src/bakery/oven.ts': null, 'src/bakery/till.ts': null };

describe('spec read from the change (ADR-035)', () => {
  it.each([
    ['head tree', true],
    ['working tree', false],
  ])('X1 .diffcity/spec.md in the %s scopes the change; the spec file itself is in the spec', async (_mode, commit) => {
    const spec = fixtureFile('spec/spec-arg-wins', 'repo-spec.md');
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { commit });
    // Added with the change, so the spec file is a touched file of it.
    if (commit) await repo.commit('spec', { '.diffcity/spec.md': spec });
    else await repo.write({ '.diffcity/spec.md': spec });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual({ '.diffcity/spec.md': true, ...BAKE_IN });
    expect(report.summary.byVerdict.spec).toBe(1);
    expect('specNotice' in report).toBe(false);
  });

  it('a dirty change reads the working tree spec, not the committed one', async () => {
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { extra: { '.diffcity/spec.md': 'Round up in `ringUp`.\n' }, commit: true });
    await repo.write({ '.diffcity/spec.md': fixtureFile('spec/spec-arg-wins', 'repo-spec.md') });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual({ '.diffcity/spec.md': true, ...BAKE_IN });
  });

  it('spec/absent-null: no spec, inSpec null everywhere, no notice, the spec verdict disabled', async () => {
    const { repo } = await fixtureRepo('spec/absent');
    const report = await build(repo.dir);
    expect(report.packages.flatMap((pkg) => pkg.files).map((file) => file.inSpec)).toEqual([null, null]);
    expect(report.summary.byVerdict.spec).toBe(0);
    expect('specNotice' in report).toBe(false);
  });

  it('spec/untouched-null: a spec committed on the base is read too, untouched files stay null', async () => {
    const { repo } = await fixtureRepo('spec/untouched-null', { extra: { '.diffcity/spec.md': fixtureFile('spec/untouched-null', 'spec.md') } });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual({ 'src/bakery/oven.ts': true, 'src/bakery/scale.ts': null, 'src/bakery/till.ts': false });
  });

  it('spec/no-root-matched-null: the notice travels in the Report', async () => {
    const { repo } = await fixtureRepo('spec/no-root-matched-null', { extra: { '.diffcity/spec.md': fixtureFile('spec/no-root-matched-null', 'spec.md') } });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual(NONE);
    expect(report.specNotice).toBe('The spec names no touched symbol or file');
  });

  it('a symlinked .diffcity/spec.md is read as its link text, never followed out of the repo', async () => {
    const outside = await scratch();
    await writeFile(join(outside, 'spec.md'), 'Bake longer in `bake`.\n', 'utf8');
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { commit: true });
    await mkdir(join(repo.dir, '.diffcity'));
    await symlink(join(outside, 'spec.md'), join(repo.dir, '.diffcity', 'spec.md'));
    const report = await build(repo.dir);
    // The link text is a path, which names no touched symbol or file.
    expect(inSpec(report)['src/bakery/oven.ts']).toBeNull();
    expect(report.specNotice).toBe('The spec names no touched symbol or file');
  });
});

describe('spec read through a .diffcity link out of the repo', () => {
  it('a .diffcity directory symlinked outside the repo is not read: no spec, and the build still succeeds', async () => {
    const outside = await scratch();
    await writeFile(join(outside, 'spec.md'), 'Bake longer in `bake`.\n', 'utf8');
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { commit: true });
    await symlink(outside, join(repo.dir, '.diffcity'));
    const report = await build(repo.dir);
    // The link itself is a touched file of the dirty change.
    expect(inSpec(report)).toEqual({ '.diffcity': null, ...NONE });
    expect('specNotice' in report).toBe(false);
  });
});

describe('spec/spec-file-too-large-absent', () => {
  it.each([
    ['head tree', true],
    ['working tree', false],
  ])('a .diffcity/spec.md above 256 KiB in the %s counts as absent, with a notice', async (_mode, commit) => {
    const { repo } = await fixtureRepo('spec/spec-file-too-large-absent', { extra: { '.diffcity/spec.md': specOfSize(MAX_SPEC_BYTES + 1) }, commit });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual(NONE);
    expect(report.specNotice).toBe(TOO_LARGE_NOTICE);
    expect(report.summary.byVerdict.spec).toBe(0);
  });

  it('a spec of exactly 256 KiB is read', async () => {
    const { repo } = await fixtureRepo('spec/spec-file-too-large-absent', { extra: { '.diffcity/spec.md': specOfSize(MAX_SPEC_BYTES) } });
    const report = await build(repo.dir);
    expect(inSpec(report)).toEqual(BAKE_IN);
  });

  it('a --spec file above 256 KiB counts as absent too', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'big.md'), specOfSize(MAX_SPEC_BYTES + 1), 'utf8');
    expect(await readSpecFile('big.md', dir)).toEqual({ kind: 'too-large' });
    await writeFile(join(dir, 'fits.md'), specOfSize(MAX_SPEC_BYTES), 'utf8');
    expect(await readSpecFile('fits.md', dir)).toMatchObject({ kind: 'text', path: join(dir, 'fits.md') });
  });
});

describe('spec/spec-arg-wins', () => {
  it('X2 --spec <file> from disk takes precedence over .diffcity/spec.md', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'task.md'), fixtureFile('spec/spec-arg-wins', 'arg-spec.md'), 'utf8');
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { extra: { '.diffcity/spec.md': fixtureFile('spec/spec-arg-wins', 'repo-spec.md') } });
    // .diffcity/spec.md alone names `bake`.
    expect(inSpec(await build(repo.dir))).toEqual(BAKE_IN);
    // --spec names `ringUp`.
    const report = await build(repo.dir, { spec: await readSpecFile(join(dir, 'task.md'), repo.dir) });
    expect(inSpec(report)).toEqual({ 'src/bakery/oven.ts': false, 'src/bakery/till.ts': true });
  });

  it('a --spec file resolves Markdown links from its own directory, on disk; .diffcity/spec.md from .diffcity/', async () => {
    const dir = await scratch();
    const { repo } = await fixtureRepo('spec/spec-arg-wins', { extra: { '.diffcity/spec.md': 'See [the oven](../src/bakery/oven.ts#L2).\n' } });
    expect(inSpec(await build(repo.dir))).toEqual(BAKE_IN);
    // From a directory outside the repo, the target goes back into it.
    const target = relative(dir, join(repo.dir, 'src/bakery/till.ts')).split(sep).join('/');
    await writeFile(join(dir, 'task.md'), `See [the till](${target}).\n`, 'utf8');
    const report = await build(repo.dir, { spec: await readSpecFile(join(dir, 'task.md'), repo.dir) });
    expect(inSpec(report)).toEqual({ 'src/bakery/oven.ts': false, 'src/bakery/till.ts': true });
  });

  it('runDiff --spec reads the file relative to the current directory; a missing one fails with exit 1', async () => {
    const { repo } = await fixtureRepo('spec/spec-arg-wins');
    await writeFile(join(repo.dir, 'task.md'), fixtureFile('spec/spec-arg-wins', 'arg-spec.md'), 'utf8');
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
    const deps = { cwd: repo.dir, io, now: NOW.toISOString(), build: (options: BuildReportOptions) => build(options.repoDir, options) };
    expect(await runDiff({ json: true, spec: 'task.md' }, deps)).toBe(0);
    const report = JSON.parse(out.join('')) as Report;
    // task.md is an untracked file of the dirty change: it is the spec file, so it is in the spec.
    expect(inSpec(report)).toEqual({ 'src/bakery/oven.ts': false, 'src/bakery/till.ts': true, 'task.md': true });
    expect(err).toEqual([]);

    out.length = 0;
    expect(await runDiff({ json: true, spec: 'missing.md' }, deps)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/^diffcity diff: --spec: .*missing\.md/);
  });
});

describe('diffcity diff --spec through the built CLI', () => {
  let fixture: FixtureRepo;
  let dir: string;
  beforeAll(async () => {
    fixture = await repoFromFixture('spec/spec-arg-wins', { extra: { '.diffcity/spec.md': fixtureFile('spec/spec-arg-wins', 'repo-spec.md') } });
    dir = await mkdtemp(join(tmpdir(), 'diffcity-spec-cli-'));
    await writeFile(join(dir, 'task.md'), fixtureFile('spec/spec-arg-wins', 'arg-spec.md'), 'utf8');
  });
  afterAll(async () => {
    await fixture.repo.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it('X2 the --spec file wins over .diffcity/spec.md', async () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [cliEntry, 'diff', '--json', '--spec', join(dir, 'task.md')], { cwd: fixture.repo.dir, env, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') reject(new Error(error.message, { cause: error }));
        else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      });
    });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(inSpec(JSON.parse(result.stdout) as Report)).toEqual({ 'src/bakery/oven.ts': false, 'src/bakery/till.ts': true });
  });
});
