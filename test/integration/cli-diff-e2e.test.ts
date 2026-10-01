// End-to-end sanity check of `diffcity diff --json` through the built CLI
// (dist/, built by test/global-setup.ts). One branch carries a sig, a mod, an
// add and a del across a plain package, a tier 1 auth package and a tier 1
// migrations package; every status and verdict is checked against SPEC.md
// sections 5.1-5.3 and ADR-009/ADR-011.

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { File, Report } from '../../src/core/report/types.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

const cliEntry = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let repo: TempRepo;
let home: string;

function runCli(args: string[]): Promise<CliResult> {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DIFFCITY_HOME: home,
  };
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, ...args], { cwd: repo.dir, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function fileMap(report: Report): Map<string, File> {
  return new Map(report.packages.flatMap((pkg) => pkg.files).map((file) => [file.path, file]));
}

const before = {
  'src/lib/pricing.ts': [
    'export function applyDiscount(total: number): number {',
    '  return total * 0.9;',
    '}',
    '',
    'export function formatPrice(value: number): string {',
    '  return `$${value}`;',
    '}',
    '',
  ].join('\n'),
  'src/lib/legacy.ts': 'export function oldHelper(): number {\n  return 1;\n}\n',
  'src/auth/token.ts': "export function issueToken(user: string): string {\n  return user + ':token';\n}\n",
  'db/migrations/001_orders.sql': 'CREATE TABLE orders (id integer primary key);\n',
  'README.md': '# Sample shop\n',
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'diffcity-e2e-home-'));
  repo = await createRepo({ files: before });
  await repo.branch('feature/discounts');
  await repo.commit('discounts', {
    // sig on applyDiscount (parameter added), mod on formatPrice (body only)
    'src/lib/pricing.ts': [
      'export function applyDiscount(total: number, rate: number): number {',
      '  return total * (1 - rate);',
      '}',
      '',
      'export function formatPrice(value: number): string {',
      '  return `$${value.toFixed(2)}`;',
      '}',
      '',
    ].join('\n'),
    // mod in a tier 1 zone
    'src/auth/token.ts': 'export function issueToken(user: string): string {\n  return `${user}:token`;\n}\n',
    // add in a tier 1 zone
    'db/migrations/002_discount.sql': 'ALTER TABLE orders ADD COLUMN discount numeric;\n',
    // del
    'src/lib/legacy.ts': null,
  });
});

afterAll(async () => {
  await repo.cleanup();
  await rm(home, { recursive: true, force: true });
});

describe('e2e: diffcity diff --json on a branch with sig, mod, add and del', () => {
  let result: CliResult;
  let report: Report;

  beforeAll(async () => {
    result = await runCli(['diff', '--json']);
    report = JSON.parse(result.stdout) as Report;
  });

  it('exits 0 with JSON on stdout and nothing on stderr', () => {
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('meta names the repo, the detected base, the branch and one commit', () => {
    expect(report.meta).toMatchObject({
      repo: basename(repo.dir),
      base: 'main',
      head: 'feature/discounts',
      commits: 1,
    });
    expect(Number.isNaN(Date.parse(report.meta.generatedAt))).toBe(false);
  });

  it('packages are parent directories in path order with tier 1 from the path', () => {
    expect(report.packages.map((pkg) => [pkg.id, pkg.path, pkg.tier1])).toEqual([
      ['db/migrations', 'db/migrations', true],
      ['src/auth', 'src/auth', true],
      ['src/lib', 'src/lib', false],
    ]);
  });

  it('the untouched README is left out (unsupported language, ADR-011)', () => {
    expect(fileMap(report).has('README.md')).toBe(false);
  });

  it('S sig: a parameter added gives symbol sig; file sig (heaviest); verdict eyes', () => {
    const file = fileMap(report).get('src/lib/pricing.ts');
    expect(file).toMatchObject({ id: 'src/lib/pricing.ts', language: 'typescript', status: 'sig', verdict: 'eyes', inSpec: null });
    expect(file?.symbols.map((s) => [s.id, s.status])).toEqual([
      ['src/lib/pricing.ts#applyDiscount', 'sig'],
      ['src/lib/pricing.ts#formatPrice', 'mod'],
    ]);
    const sig = file?.symbols[0];
    expect(sig?.signatureBefore).toBe('function applyDiscount(total: number): number');
    expect(sig?.signatureAfter).toBe('function applyDiscount(total: number, rate: number): number');
  });

  it('S mod in a tier 1 zone: symbol mod, file mod, verdict eyes', () => {
    const file = fileMap(report).get('src/auth/token.ts');
    expect(file).toMatchObject({ status: 'mod', verdict: 'eyes' });
    expect(file?.symbols.map((s) => [s.id, s.status])).toEqual([['src/auth/token.ts#issueToken', 'mod']]);
  });

  it('S add in a tier 1 zone: new migration is add, verdict eyes', () => {
    const file = fileMap(report).get('db/migrations/002_discount.sql');
    expect(file).toMatchObject({ language: 'sql', status: 'add', verdict: 'eyes' });
    expect(file?.symbols.map((s) => [s.name, s.kind, s.status])).toEqual([['ALTER TABLE orders', 'sql', 'add']]);
  });

  it('S del outside tier 1: deleted file is del with its symbols del, verdict ok', () => {
    const file = fileMap(report).get('src/lib/legacy.ts');
    expect(file).toMatchObject({ status: 'del', verdict: 'ok' });
    expect(file?.symbols.map((s) => [s.id, s.status])).toEqual([['src/lib/legacy.ts#oldHelper', 'del']]);
  });

  it('ADR-009: the untouched migration in a tier 1 zone is same/same', () => {
    const file = fileMap(report).get('db/migrations/001_orders.sql');
    expect(file).toMatchObject({ status: 'same', verdict: 'same', inSpec: null });
    expect(file?.symbols.map((s) => [s.name, s.status])).toEqual([['CREATE TABLE orders', 'same']]);
  });

  it('summary counts symbols by status, files by verdict, and lists touched tier 1 files', () => {
    expect(report.steps).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({
      files: 5,
      byStatus: { add: 1, mod: 2, sig: 1, del: 1, same: 1 },
      byVerdict: { eyes: 3, risky: 0, spec: 0, ok: 1, same: 1 },
      tier1Files: ['db/migrations/002_discount.sql', 'src/auth/token.ts'],
    });
  });

  it('starts no daemon and writes nothing to DIFFCITY_HOME', async () => {
    expect(await readdir(home)).toEqual([]);
  });
});

describe('e2e: a touched README in the working tree', () => {
  it('is included with its git status mod, language other, no symbols, verdict ok', async () => {
    await repo.write({ 'README.md': '# Sample shop\n\nNow with discounts.\n' });
    try {
      const result = await runCli(['diff', '--json']);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as Report;
      const file = fileMap(report).get('README.md');
      expect(file).toMatchObject({ id: 'README.md', language: 'other', status: 'mod', verdict: 'ok', symbols: [] });
      expect(report.packages[0]?.path).toBe('.');
      expect(report.packages[0]?.files.map((f) => f.path)).toEqual(['README.md']);
    } finally {
      await repo.git('checkout', '--', 'README.md');
    }
  });
});

describe('e2e: text summary and errors', () => {
  it('without --json prints the text summary and exits 0', async () => {
    const result = await runCli(['diff']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('symbols by status: add 1, mod 2, sig 1, del 1, same 1');
    expect(result.stdout).toContain('files by verdict: eyes 3, risky 0, spec 0, ok 1, same 1');
  });

  it('an unknown --base goes to stderr with exit 1 and empty stdout', async () => {
    const result = await runCli(['diff', '--json', '--base', 'no-such-branch']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no-such-branch');
  });
});
