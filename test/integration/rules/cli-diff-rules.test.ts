// `diffcity diff --json` carries the rule checks (ADR-030): the user's rules
// from settings.json in a temp DIFFCITY_HOME, then the repo config's. Built
// CLI (dist/, built by test/global-setup.ts), invented `acme-cli` repo.

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
const owned: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  while (owned.length > 0) await owned.pop()?.cleanup();
});

function diffJson(repo: TempRepo, home: TempHome): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...home.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', DIFFCITY_NOW: '2026-02-03T04:05:06Z' };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, 'diff', '--json', '--base', 'main'], { cwd: repo.dir, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
      else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

describe('diff --json and the rules', () => {
  it('includes one check per configured rule, from the settings and the repo config', async () => {
    const config = `export default { rules: [{ id: 'repo-size', kind: 'file-size', maxLines: 3 }] };\n`;
    const repo = await createRepo({ name: 'acme-cli', files: { 'diffcity.config.js': config, 'src/main.ts': 'export const run = 1;\n' } });
    owned.push(repo);
    await repo.branch('feature');
    await repo.commit('more', { 'src/main.ts': 'export const run = 1;\nexport const a = 1;\nexport const b = 1;\nexport const c = 1;\n' });
    const home = await tempHome();
    owned.push(home);
    await mkdir(home.home, { recursive: true });
    const root = await realpath(repo.dir);
    await writeFile(
      join(home.home, 'settings.json'),
      JSON.stringify({ v: 1, trustedRepos: [], rules: [{ id: 'ci', kind: 'pipeline' }], repos: { [root]: { rules: [{ id: 'user-size', kind: 'file-size', maxBytes: 10 }] } } }),
    );

    const result = await diffJson(repo, home);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.checks).toEqual([
      { ruleId: 'ci', kind: 'pipeline', state: 'not-checked', findings: 0, checkedAt: '2026-02-03T04:05:06.000Z' },
      { ruleId: 'repo-size', kind: 'file-size', state: 'violations', findings: 1, checkedAt: '2026-02-03T04:05:06.000Z' },
      { ruleId: 'user-size', kind: 'file-size', state: 'violations', findings: 1, checkedAt: '2026-02-03T04:05:06.000Z' },
    ]);
    expect(report.findings.map((finding) => [finding.source, finding.title])).toEqual([
      ['rule:repo-size', 'File over 3 lines'],
      ['rule:user-size', 'File over 10 bytes'],
    ]);
  });

  it('an unreadable settings file is a note on stderr; the repo config rules still apply', async () => {
    const config = `export default { rules: [{ id: 'repo-size', kind: 'file-size', maxLines: 100 }] };\n`;
    const repo = await createRepo({ name: 'acme-cli', files: { 'diffcity.config.js': config, 'src/main.ts': 'export const run = 1;\n' } });
    owned.push(repo);
    await repo.branch('feature');
    await repo.commit('more', { 'src/main.ts': 'export const run = 2;\n' });
    const home = await tempHome();
    owned.push(home);
    await mkdir(home.home, { recursive: true });
    await writeFile(join(home.home, 'settings.json'), '{"v":1,');

    const result = await diffJson(repo, home);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^diffcity diff: settings: .*not valid JSON.*; no user rules applied\n$/);
    expect((JSON.parse(result.stdout) as Report).checks?.map((check) => [check.ruleId, check.state])).toEqual([['repo-size', 'passed']]);
  });
});
