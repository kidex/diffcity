import { describe, expect, it } from 'vitest';
import { NOW_ENV, formatSummary, runDiff, type DiffDeps } from '../../src/cli/diff.js';
import { ConfigError } from '../../src/core/config/index.js';
import { GitError } from '../../src/core/git/index.js';
import { assembleReport, type BuildReportOptions } from '../../src/core/report/index.js';
import type { Report } from '../../src/core/report/types.js';

const meta: Report['meta'] = {
  repo: 'sample-bakery',
  base: 'main',
  head: 'feature/rolls',
  commits: 2,
  generatedAt: '2026-03-04T05:06:07.000Z',
};

const sampleReport = assembleReport(
  meta,
  [
    {
      path: 'src/billing/rates.ts',
      language: 'typescript',
      status: 'mod',
      symbols: [{ id: 'src/billing/rates.ts#rate', name: 'rate', kind: 'function', status: 'mod', range: { start: 1, end: 3 } }],
    },
    {
      path: 'src/kitchen/oven.ts',
      language: 'typescript',
      status: 'sig',
      symbols: [
        { id: 'src/kitchen/oven.ts#heat', name: 'heat', kind: 'function', status: 'sig', range: { start: 1, end: 3 } },
        { id: 'src/kitchen/oven.ts#vent', name: 'vent', kind: 'function', status: 'same', range: { start: 5, end: 7 } },
      ],
    },
    { path: 'src/kitchen/tray.ts', language: 'typescript', status: 'same', symbols: [] },
    { path: 'docs/menu.md', language: 'other', status: 'add', symbols: [] },
  ],
  (path) => path.includes('billing'),
);

interface Captured {
  stdout: string;
  stderr: string;
  calls: BuildReportOptions[];
}

function harness(build: (options: BuildReportOptions) => Promise<Report>): { deps: DiffDeps; out: Captured } {
  const out: Captured = { stdout: '', stderr: '', calls: [] };
  const deps: DiffDeps = {
    cwd: '/work/sample-bakery',
    io: { stdout: (t) => (out.stdout += t), stderr: (t) => (out.stderr += t) },
    build: (options) => {
      out.calls.push(options);
      return build(options);
    },
  };
  return { deps, out };
}

describe('diffcity diff', () => {
  it('--json writes the report as JSON to stdout and returns 0', async () => {
    const { deps, out } = harness(() => Promise.resolve(sampleReport));
    const code = await runDiff({ json: true, base: 'trunk', head: 'feature/rolls' }, deps);
    expect(code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.stdout)).toEqual(sampleReport);
    expect(out.calls).toEqual([{ repoDir: '/work/sample-bakery', trustConfig: true, base: 'trunk', head: 'feature/rolls' }]);
  });

  it('without --json prints the text summary', async () => {
    const { deps, out } = harness(() => Promise.resolve(sampleReport));
    expect(await runDiff({}, deps)).toBe(0);
    expect(out.stdout).toBe(formatSummary(sampleReport));
    expect(out.calls).toEqual([{ repoDir: '/work/sample-bakery', trustConfig: true, base: undefined, head: undefined }]);
  });

  it.each([
    ['GitError', new GitError('no-base', 'no base branch found; pass --base or set base in diffcity.config.js')],
    ['ConfigError', new ConfigError('diffcity.config.js: field "base" must be a non-empty string', 'base')],
    ['any other error', new Error('disk on fire')],
  ])('%s: one line on stderr, nothing on stdout, exit code 1', async (_name, error) => {
    const { deps, out } = harness(() => Promise.reject(error));
    expect(await runDiff({ json: true }, deps)).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(`diffcity diff: ${error.message}\n`);
  });

  it('DIFFCITY_NOW (deps.now) fixes meta.generatedAt through the build options', async () => {
    const { deps, out } = harness(() => Promise.resolve(sampleReport));
    deps.now = '2026-09-21T10:00:00.000Z';
    expect(await runDiff({ json: true }, deps)).toBe(0);
    expect(out.calls[0]?.now?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it('DIFFCITY_NOW with a UTC offset is accepted', async () => {
    const { deps, out } = harness(() => Promise.resolve(sampleReport));
    deps.now = '2026-09-21T12:00:00+02:00';
    expect(await runDiff({ json: true }, deps)).toBe(0);
    expect(out.calls[0]?.now?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
  });

  it('without DIFFCITY_NOW the build gets no fixed time', async () => {
    const { deps, out } = harness(() => Promise.resolve(sampleReport));
    expect(await runDiff({ json: true }, deps)).toBe(0);
    expect(out.calls[0]?.now).toBeUndefined();
  });

  it.each(['yesterday', '2026-09-21', '2026-13-40T99:00:00Z', '', '2026-02-30T00:00:00Z', '2026-09-21T24:00:00Z'])(
    'DIFFCITY_NOW=%j is refused with exit 1 before building',
    async (value) => {
      const { deps, out } = harness(() => Promise.resolve(sampleReport));
      deps.now = value;
      expect(await runDiff({ json: true }, deps)).toBe(1);
      expect(out.calls).toEqual([]);
      expect(out.stdout).toBe('');
      expect(out.stderr).toBe(
        `diffcity diff: ${NOW_ENV} must be an ISO 8601 date-time such as 2026-01-01T00:00:00Z, got ${JSON.stringify(value)}\n`,
      );
    },
  );

  it('squashes a multi-line error message into one line', async () => {
    const { deps, out } = harness(() => Promise.reject(new GitError('git-failed', 'git diff failed: fatal: bad\n  object\n')));
    expect(await runDiff({}, deps)).toBe(1);
    expect(out.stderr).toBe('diffcity diff: git diff failed: fatal: bad object\n');
  });
});

describe('formatSummary', () => {
  it('shows repo, range, counts by status and verdict, and tier 1 files', () => {
    expect(formatSummary(sampleReport)).toBe(
      [
        'sample-bakery: main...feature/rolls (2 commits)',
        'files: 4 (3 touched)',
        'symbols by status: add 0, mod 1, sig 1, del 0, same 1',
        'files by verdict: eyes 2, risky 0, spec 0, ok 1, same 1',
        'tier 1 files (1):',
        '  src/billing/rates.ts',
        '',
      ].join('\n'),
    );
  });

  it('says none when no tier 1 file is touched, and singular commit', () => {
    const report = assembleReport({ ...meta, commits: 1 }, [], () => false);
    const text = formatSummary(report);
    expect(text).toContain('sample-bakery: main...feature/rolls (1 commit)\n');
    expect(text).toContain('tier 1 files: none\n');
  });
});
