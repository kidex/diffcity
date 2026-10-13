// DC-126 end to end: file-size include/exclude and layers module globs go
// through the one linear matcher (src/core/rules/glob.ts), seen from the built
// CLI's `diffcity diff --json` with rules in a temp DIFFCITY_HOME's
// settings.json. Invented `tidepool` repo.

import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

const cliEntry = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));
const NOW = '2026-03-04T05:06:07.000Z';
const owned: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  while (owned.length > 0) await owned.pop()?.cleanup();
});

function diffJson(repo: TempRepo, home: TempHome): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const env = { ...home.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', DIFFCITY_NOW: NOW };
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, 'diff', '--json', '--base', 'main'], { cwd: repo.dir, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const BIG = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

/** A repo where every listed file grows to three lines on `feature`, and a home whose settings hold `rules` for it. */
async function setup(files: string[], rules: unknown[]): Promise<{ repo: TempRepo; home: TempHome }> {
  const initial = Object.fromEntries(files.map((path) => [path, 'export const a = 1;\n']));
  const repo = await createRepo({ name: 'tidepool', files: initial });
  owned.push(repo);
  await repo.branch('feature');
  await repo.commit('grow', Object.fromEntries(files.map((path) => [path, BIG])));
  const home = await tempHome();
  owned.push(home);
  await mkdir(home.home, { recursive: true });
  const root = await realpath(repo.dir);
  await writeFile(join(home.home, 'settings.json'), JSON.stringify({ v: 1, trustedRepos: [], repos: { [root]: { rules } } }));
  return { repo, home };
}

async function report(repo: TempRepo, home: TempHome): Promise<{ report: Report; ms: number }> {
  const result = await diffJson(repo, home);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return { report: JSON.parse(result.stdout) as Report, ms: result.ms };
}

function flagged(report: Report, ruleId: string): string[] {
  return report.findings
    .filter((finding) => finding.source === `rule:${ruleId}`)
    .map((finding) => finding.file)
    .sort();
}

const FILES = ['src/api/deep/handler.ts', 'src/api/route.ts', 'src/main.ts', 'scripts/seed.ts', 'src/api/route.test.ts'];

describe('DC-126 globs through diffcity diff', () => {
  it('a ** pattern selects touched files at any depth, exclude with * drops the tests', async () => {
    const { repo, home } = await setup(FILES, [
      { id: 'deep', kind: 'file-size', maxLines: 2, include: ['src/**/*.ts'], exclude: ['src/api/*.test.ts'] },
    ]);
    const { report: built } = await report(repo, home);
    expect(flagged(built, 'deep')).toEqual(['src/api/deep/handler.ts', 'src/api/route.ts', 'src/main.ts']);
  });

  it('a * pattern stays within one segment', async () => {
    const { repo, home } = await setup(FILES, [{ id: 'flat', kind: 'file-size', maxLines: 2, include: ['src/api/*.ts'] }]);
    const { report: built } = await report(repo, home);
    expect(flagged(built, 'flat')).toEqual(['src/api/route.test.ts', 'src/api/route.ts']);
  });

  it('an entry without a star is a path prefix', async () => {
    const { repo, home } = await setup(FILES, [{ id: 'prefix', kind: 'file-size', maxLines: 2, include: ['src/api/de'], exclude: ['scripts'] }]);
    const { report: built } = await report(repo, home);
    expect(flagged(built, 'prefix')).toEqual(['src/api/deep/handler.ts']);
  });

  it('a layers rule with glob modules still flags a forbidden import', async () => {
    const repo = await createRepo({
      name: 'tidepool',
      files: { 'apps/web/page.ts': 'export const page = 1;\n', 'libs/money/sum.ts': 'export const sum = 1;\n' },
    });
    owned.push(repo);
    await repo.branch('feature');
    await repo.commit('upward', { 'libs/money/sum.ts': "import { page } from '../../apps/web/page.js';\nexport const sum = page;\n" });
    const home = await tempHome();
    owned.push(home);
    await mkdir(home.home, { recursive: true });
    const root = await realpath(repo.dir);
    await writeFile(
      join(home.home, 'settings.json'),
      JSON.stringify({ v: 1, trustedRepos: [], repos: { [root]: { rules: [{ id: 'tiers', kind: 'layers', layers: [['apps/*'], ['libs/*']] }] } } }),
    );
    const { report: built } = await report(repo, home);
    expect(built.checks?.map((check) => [check.ruleId, check.state, check.findings])).toEqual([['tiers', 'violations', 1]]);
    expect(built.findings.map((finding) => [finding.source, finding.file, finding.title])).toEqual([
      ['rule:tiers', 'libs/money/sum.ts', 'Upward import: libs/money → apps/web'],
    ]);
  });

  it('a 1,025-character include entry is a rule error naming the rule and field; the rule does not run', async () => {
    const long = `src/${'a'.repeat(1021)}`;
    expect(long).toHaveLength(1025);
    const { repo, home } = await setup(FILES, [{ id: 'too-long', kind: 'file-size', maxLines: 2, include: [long] }]);
    const { report: built } = await report(repo, home);
    expect(built.checks).toHaveLength(1);
    const check = built.checks?.[0];
    expect(check).toMatchObject({ ruleId: 'too-long', kind: 'file-size', state: 'error', findings: 0 });
    expect(check?.reason).toContain('too-long');
    expect(check?.reason).toContain('field "include"');
    expect(check?.reason).toContain('1024');
    expect(flagged(built, 'too-long')).toEqual([]);
  });

  it('a 1,024-character many-star entry is accepted and the diff finishes quickly', async () => {
    const stars = '*a'.repeat(511) + 'zz';
    expect(stars).toHaveLength(1024);
    const deepName = `src/${'a/'.repeat(200)}aaaa.ts`;
    const { repo, home } = await setup(['src/main.ts', deepName], [{ id: 'stars', kind: 'file-size', maxLines: 2, include: [stars, 'src/**/*.ts'] }]);
    const { report: built, ms } = await report(repo, home);
    expect(built.checks?.map((check) => [check.ruleId, check.state])).toEqual([['stars', 'violations']]);
    expect(flagged(built, 'stars')).toEqual([deepName, 'src/main.ts'].sort());
    expect(ms).toBeLessThan(15_000);
  });
});
