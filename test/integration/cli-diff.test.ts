// `diffcity diff` through the built CLI (dist/, built by test/global-setup.ts)
// against temp repos from test/fixtures/report/cli-json-stdout.

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/core/report/index.js';
import type { File, Report } from '../../src/core/report/types.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { repoFromFixture, type FixtureRepo } from '../helpers/fixture-repo.js';
import { createRepo } from '../helpers/repo.js';

isolateGitConfig();

const cliEntry = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cliEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

function runCli(cwd: string, args: string[]): Promise<CliResult> {
  const env = cliEnv;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, ...args], { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function files(report: Report): File[] {
  return report.packages.flatMap((pkg) => pkg.files);
}

let fixture: FixtureRepo;
let emptyDir: string;

beforeAll(async () => {
  fixture = await repoFromFixture('report/cli-json-stdout');
  emptyDir = await mkdtemp(join(tmpdir(), 'diffcity-not-a-repo-'));
});

afterAll(async () => {
  await fixture.repo.cleanup();
  await rm(emptyDir, { recursive: true, force: true });
});

describe('report/cli-json-stdout: diffcity diff --json', () => {
  it('writes the Report JSON to stdout with exit code 0 and nothing on stderr', async () => {
    const result = await runCli(fixture.repo.dir, ['diff', '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(files(report).map((f) => [f.path, f.status, f.verdict])).toEqual([
      ['src/bakery/oven.ts', 'sig', 'eyes'],
      ['src/bakery/shelf.ts', 'same', 'same'],
      ['src/session/crumb.ts', 'mod', 'eyes'],
    ]);
    expect(report.summary.tier1Files).toEqual(['src/session/crumb.ts']);
    expect(report.meta).toMatchObject({ base: 'main', head: 'feature/work', commits: 1 });
  });

  it('prints the same Report buildReport produces in-process', async () => {
    const result = await runCli(fixture.repo.dir, ['diff', '--json']);
    const fromCli = JSON.parse(result.stdout) as Report;
    const inProcess = await buildReport({
      repoDir: fixture.repo.dir,
      now: new Date(fromCli.meta.generatedAt),
      runner: ghForbidden().runner,
    });
    expect(fromCli).toEqual(inProcess);
  });

  it('honours --base and --head', async () => {
    const result = await runCli(fixture.repo.dir, ['diff', '--json', '--base', 'main', '--head', 'main']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.meta).toMatchObject({ base: 'main', head: 'main', commits: 0 });
    expect(files(report).every((f) => f.status === 'same')).toBe(true);
    expect(report.summary.tier1Files).toEqual([]);
  });

  it('works from a subdirectory of the repo', async () => {
    const result = await runCli(join(fixture.repo.dir, 'src', 'bakery'), ['diff', '--json']);
    expect(result.code).toBe(0);
    expect(files(JSON.parse(result.stdout) as Report)).toHaveLength(3);
  });
});

describe('diffcity diff (text summary)', () => {
  it('prints counts by status and verdict and the tier 1 files', async () => {
    const result = await runCli(fixture.repo.dir, ['diff']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const repoName = JSON.parse((await runCli(fixture.repo.dir, ['diff', '--json'])).stdout) as Report;
    expect(result.stdout).toBe(
      [
        `${repoName.meta.repo}: main...feature/work (1 commit)`,
        'files: 3 (2 touched)',
        'symbols by status: add 0, mod 1, sig 1, del 0, same 1',
        'files by verdict: eyes 2, risky 0, spec 0, ok 0, same 1',
        'tier 1 files (1):',
        '  src/session/crumb.ts',
        '',
      ].join('\n'),
    );
  });
});

describe('diffcity diff errors: one line on stderr, exit code 1', () => {
  function expectOneLineError(result: CliResult, pattern: RegExp): void {
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.endsWith('\n')).toBe(true);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(pattern);
  }

  it('GitError: not a git repository', async () => {
    expectOneLineError(await runCli(emptyDir, ['diff', '--json']), /^diffcity diff: not a git repository/);
  });

  it('GitError: unknown base', async () => {
    expectOneLineError(
      await runCli(fixture.repo.dir, ['diff', '--json', '--base', 'no-such-branch']),
      /^diffcity diff: .*no-such-branch/,
    );
  });

  it('GitError: unknown head', async () => {
    expectOneLineError(
      await runCli(fixture.repo.dir, ['diff', '--head', 'no-such-head']),
      /^diffcity diff: head ref not found: no-such-head/,
    );
  });

  it('ConfigError: a bad diffcity.config.js names the field', async () => {
    const other = await repoFromFixture('report/cli-json-stdout');
    try {
      await writeFile(join(other.repo.dir, 'diffcity.config.js'), 'export default { base: 42 };\n', 'utf8');
      expectOneLineError(await runCli(other.repo.dir, ['diff', '--json']), /^diffcity diff: diffcity\.config\.js: field "base"/);
    } finally {
      await other.repo.cleanup();
    }
  });
});

describe('diffcity diff --json into a pipe closed early (e.g. `| head`)', () => {
  it('exits quietly with code 0 instead of crashing on EPIPE', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `export function step${String(i)}(n: number): number {\n  return n + ${String(i)};\n}\n`).join('\n');
    const tree = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`src/line${String(i)}/station.ts`, body]));
    const repo = await createRepo({ files: tree });
    try {
      await repo.branch('feature/big');
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [cliEntry, 'diff', '--json'], { cwd: repo.dir, env: cliEnv });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.stdout.once('data', () => child.stdout.destroy());
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code, stderr });
        });
      });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});
