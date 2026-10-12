// Golden tests for `diffcity diff --json` (phase 1 definition of done, ADR-014).
//
// Each scenario under test/fixtures/scenarios/ is built as a temp repo named
// after its invented repo, the built CLI (dist/, from test/global-setup.ts)
// runs `diff --json` in it with DIFFCITY_NOW fixing meta.generatedAt, and the
// output must equal expected.json byte for byte.
//
// Regenerate the goldens with `UPDATE_GOLDEN=1 npm test`, then review every
// changed expected.json against SPEC.md 5.1-5.4 and ADR-005..009, ADR-034 before
// committing. The tables in ./golden-review.ts (every file, every symbol,
// packages, tier 1 files; summary counts derived from them) are written by
// hand and never regenerated: they catch a golden that was accepted blindly.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { File, Report, Status, Verdict } from '../../src/core/report/types.js';
import { buildScenario, listScenarios, type BuiltScenario } from '../helpers/scenario.js';
import { reviewed, type ReviewedScenario } from './golden-review.js';

const cliEntry = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const updateGolden = process.env.UPDATE_GOLDEN === '1';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
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

function cliEnv(home: string, now: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DIFFCITY_HOME: home,
    DIFFCITY_NOW: now,
  };
}

/** Symbol ids without the `path#` prefix, with their status. */
function symbolRows(file: File): [string, Status][] {
  return file.symbols.map((symbol) => [symbol.id.slice(file.path.length + 1), symbol.status]);
}

const scenarios = listScenarios();

describe('golden scenarios', () => {
  it('are exactly the three phase 1 changes and the spec scope one, each with a hand-reviewed table', () => {
    expect(scenarios.map((s) => s.name)).toEqual(['order-discounts', 'report-cli-command', 'session-refresh', 'spec-scope']);
    expect(Object.keys(reviewed).sort()).toEqual(scenarios.map((s) => s.name));
  });
});

describe.each(scenarios)('scenario $name', (scenario) => {
  let built: BuiltScenario;
  let home: string;
  let result: CliResult;
  let report: Report;
  let statusBefore: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'diffcity-golden-home-'));
    built = await buildScenario(scenario);
    statusBefore = await built.repo.status();
    result = await runCli(built.repo.dir, ['diff', '--json'], cliEnv(home, scenario.steps.now));
    report = JSON.parse(result.stdout) as Report;
    if (updateGolden && result.code === 0) writeFileSync(scenario.expectedPath, result.stdout, 'utf8');
    // Builds a whole repo and runs the built CLI: dozens of git processes, slow under parallel load.
  }, 120_000);

  afterAll(async () => {
    await built.repo.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it('exits 0 with nothing on stderr', () => {
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('matches expected.json byte for byte', () => {
    expect(existsSync(scenario.expectedPath), `${scenario.expectedPath} is missing; run UPDATE_GOLDEN=1 npm test`).toBe(
      true,
    );
    const expected = readFileSync(scenario.expectedPath, 'utf8');
    // Structural comparison first for a readable diff, then the exact bytes (key order, indentation).
    expect(report).toStrictEqual(JSON.parse(expected));
    expect(result.stdout).toBe(expected);
  });

  it('meta has the invented repo name, the fixed clock and the detected base', () => {
    expect(report.meta.repo).toBe(scenario.steps.repo);
    expect(report.meta.generatedAt).toBe(new Date(scenario.steps.now).toISOString());
    expect(report.meta.base).toBe(scenario.steps.base);
    expect(report.meta.head).toBe(scenario.steps.branch);
    expect(report.meta.commits).toBe(scenario.steps.commits.length);
  });

  it('every file, symbol and package matches the hand-reviewed table', () => {
    const table: ReviewedScenario | undefined = reviewed[scenario.name];
    if (table === undefined) throw new Error(`no hand-reviewed table for ${scenario.name}`);
    const files = report.packages.flatMap((pkg) => pkg.files);
    expect(files.map((file) => [file.path, file.status, file.verdict])).toEqual(table.files);
    expect(Object.fromEntries(files.map((file) => [file.path, symbolRows(file)]))).toEqual(table.symbols);
    expect(Object.keys(table.symbols).sort()).toEqual(table.files.map(([path]) => path).sort());
    expect(report.packages.map((pkg) => [pkg.path, pkg.tier1])).toEqual(table.packages);
    expect(report.summary.tier1Files).toEqual(table.tier1Files);
  });

  it('the execution path matches the hand-reviewed table, step by step (SPEC.md 5.4, ADR-034)', () => {
    const table: ReviewedScenario | undefined = reviewed[scenario.name];
    if (table === undefined) throw new Error(`no hand-reviewed table for ${scenario.name}`);
    expect(report.steps.map((step) => [step.section ?? 'path', step.symbolId, step.entry ?? null, step.why])).toEqual(table.path);
    expect(report.steps.map((step) => step.order)).toEqual(table.path.map((_, index) => index + 1));
    const files = report.packages.flatMap((pkg) => pkg.files);
    expect(report.steps.map((step) => step.fileId)).toEqual(report.steps.map((step) => step.symbolId.slice(0, step.symbolId.indexOf('#'))));
    const sig = Object.fromEntries(
      files.flatMap((file) => file.symbols.filter((symbol) => symbol.status === 'sig').map((symbol) => [symbol.id, symbol.callsites])),
    );
    expect(sig).toEqual(table.callsites);
  });

  it('golden/no-spec-unchanged: inSpec matches the hand-reviewed table; without a spec every file is null and there is no notice', () => {
    const table: ReviewedScenario | undefined = reviewed[scenario.name];
    if (table === undefined) throw new Error(`no hand-reviewed table for ${scenario.name}`);
    const files = report.packages.flatMap((pkg) => pkg.files);
    expect(files.map((file) => [file.path, file.inSpec])).toEqual(table.inSpec ?? files.map((file) => [file.path, null]));
    // A spec that marks something has no notice either; a scenario without one is byte-identical to its phase 1 golden.
    expect('specNotice' in report).toBe(false);
  });

  it('summary counts match the ones derived from the hand-reviewed table', () => {
    const table: ReviewedScenario | undefined = reviewed[scenario.name];
    if (table === undefined) throw new Error(`no hand-reviewed table for ${scenario.name}`);
    const byStatus: Record<Status, number> = { add: 0, mod: 0, sig: 0, del: 0, same: 0 };
    for (const rows of Object.values(table.symbols)) for (const [, status] of rows) byStatus[status] += 1;
    const byVerdict: Record<Verdict, number> = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };
    for (const [, , verdict] of table.files) byVerdict[verdict] += 1;
    expect(report.summary).toEqual({ files: table.files.length, byStatus, byVerdict, tier1Files: table.tier1Files });
  });

  it('leaves the repo as it found it and writes nothing to DIFFCITY_HOME', async () => {
    expect(await built.repo.status()).toBe(statusBefore);
    expect(await readdir(home)).toEqual([]);
  });
});
