// Adversarial cases of the execution path (SPEC.md 5.4, ADR-034): recursion,
// the names fallback above 400 files, route registrations the scanner meets
// in the wild, SQL files with several statements, a TSX component tree, moved
// but unchanged symbols, CRLF files and a renamed and modified file.

import { afterEach, describe, expect, it } from 'vitest';
import { compareFileWithFingerprints } from '../../src/core/diff/status.js';
import { MAX_TS_MORPH_FILES } from '../../src/core/path/graph.js';
import { buildExecutionPath, type ExecutionPathInput } from '../../src/core/path/order.js';
import { preparePathFile, prepareUntouchedFile, type PathFile } from '../../src/core/path/prepare.js';
import { languageForPath } from '../../src/core/parse/language.js';
import { buildReport } from '../../src/core/report/build.js';
import type { Report, Step } from '../../src/core/report/types.js';
import { repoFromFixture, type FixtureRepo } from '../helpers/fixture-repo.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { fixturePath, id } from '../helpers/path-fixture.js';

isolateGitConfig();

const opened: FixtureRepo[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.repo.cleanup();
});

/** `order section symbolId <- entry : why`, one string per step. */
function rows(steps: readonly Step[]): string[] {
  return steps.map(
    (step) => `${String(step.order)} ${step.section ?? 'path'} ${step.symbolId}${step.entry === undefined ? '' : ` <- ${step.entry}`} : ${step.why}`,
  );
}

const adversarial = (name: string): Promise<ExecutionPathInput> => fixturePath(`adversarial/${name}`);

/** The input of buildExecutionPath for two in-memory trees, prepared as buildReport does (see path-fixture.ts). */
async function inMemoryPath(before: Record<string, string>, after: Record<string, string>, log?: (message: string) => void): Promise<ExecutionPathInput> {
  const files: PathFile[] = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (languageForPath(path) === null) continue;
    const b = before[path] ?? null;
    const a = after[path] ?? null;
    const change = b === null ? 'add' : a === null ? 'del' : 'mod';
    const { status, symbols, ranges } = await compareFileWithFingerprints({ path, change, binary: false, before: b, after: a });
    if (status === 'same') {
      const untouched = a === null ? null : await prepareUntouchedFile(path, a, symbols);
      if (untouched !== null) files.push(untouched);
      continue;
    }
    files.push(await preparePathFile({ path, status, before: b, after: a, symbols, ranges }));
  }
  return { files, tsconfig: null, packageJson: null, log };
}

describe('path adversarial', () => {
  it('recursion: a self-recursive function and two mutually recursive ones are each one step, and the BFS ends', async () => {
    const { steps } = await buildExecutionPath(await adversarial('recursion'));
    const main = id('src/main.ts', 'main');
    expect(rows(steps)).toEqual([
      `1 path ${main} <- ${main} : Body changed`,
      `2 path ${id('src/walk.ts', 'walk')} <- ${main} : New function`,
      `3 path ${id('src/walk.ts', 'ping')} <- ${main} : New function`,
      `4 path ${id('src/walk.ts', 'pong')} <- ${main} : New function`,
    ]);
  });

  it('names-fallback-over-400-files: more than 400 TS files fall back to name matching, log it, and keep a deterministic order', async () => {
    const count = MAX_TS_MORPH_FILES + 1;
    const pad = (n: number): string => String(n).padStart(3, '0');
    const after: Record<string, string> = {
      'src/main.ts': "import { hop000 } from './hops/m000';\n\nexport function main(): number {\n  return hop000();\n}\n",
    };
    for (let i = 0; i < count; i++) {
      const next = i + 1 < count ? pad(i + 1) : null;
      after[`src/hops/m${pad(i)}.ts`] =
        next === null
          ? `export function hop${pad(i)}(): number {\n  return ${String(i)};\n}\n`
          : `import { hop${next} } from './m${next}';\n\nexport function hop${pad(i)}(): number {\n  return hop${next}();\n}\n`;
    }
    const before = { 'src/main.ts': 'export function main(): number {\n  return 0;\n}\n' };
    const notes: string[] = [];
    const input = await inMemoryPath(before, after, (message) => notes.push(message));
    const first = await buildExecutionPath(input);
    expect(first.mode).toBe('names');
    expect(notes.length).toBeGreaterThan(0);

    const main = id('src/main.ts', 'main');
    const expected = [main, ...Array.from({ length: count }, (_, i) => id(`src/hops/m${pad(i)}.ts`, `hop${pad(i)}`))];
    expect(first.steps.map((step) => step.symbolId)).toEqual(expected);
    expect(first.steps.every((step) => step.section === 'path' && step.entry === main)).toBe(true);
    expect(first.steps.map((step) => step.order)).toEqual(expected.map((_, i) => i + 1));

    // A shuffled input gives the same steps.
    const shuffled = [...input.files].sort((a, b) => (a.path.split('').reverse().join('') < b.path.split('').reverse().join('') ? -1 : 1));
    const second = await buildExecutionPath({ ...input, files: shuffled });
    expect(JSON.stringify(second.steps)).toBe(JSON.stringify(first.steps));
  }, 120_000);

  it('route-handler-array: a handler passed inside an array of handlers is the route entry', async () => {
    // Express accepts `app.get(path, [mw, handler])`; the registration is untouched, the handler modified.
    const { steps } = await buildExecutionPath(await adversarial('route-handler-array'));
    const list = id('src/parcels.ts', 'listParcels');
    expect(rows(steps)).toEqual([`1 path ${list} <- ${list} : Endpoint changed: GET /parcels`]);
  });

  it('route-in-loop: a table-driven registration (path not a literal) registers no route; the literal one still does', async () => {
    const { steps } = await buildExecutionPath(await adversarial('route-in-loop'));
    const register = id('src/server.ts', 'registerRoutes');
    expect(rows(steps)).toEqual([
      `1 path ${register} <- ${register} : New endpoint GET /health`,
      // Known limit: handlers registered through a loop over a table are not entries.
      `2 unconnected ${id('src/parcels.ts', 'listParcels')} : New function`,
      `3 unconnected ${id('src/parcels.ts', 'createParcel')} : New function`,
    ]);
  });

  it('route-handler-test-helper: a new handler that lives under __tests__ is one step, classified once, its why from the rule order', async () => {
    const { steps } = await buildExecutionPath(await adversarial('route-handler-test-helper'));
    const register = id('src/server.ts', 'registerRoutes');
    const sample = id('src/__tests__/samples.ts', 'serveSample');
    expect(rows(steps)).toEqual([
      `1 path ${register} <- ${register} : New endpoint GET /samples`,
      // A controller handler (class 2) before a new test (class 5); "add test" precedes "add" in the why rules.
      `2 path ${sample} <- ${sample} : New test`,
    ]);
  });

  it('sql-several-statements: each changed statement is one migration step in file then range order; unchanged ones give none', async () => {
    const { steps } = await buildExecutionPath(await adversarial('sql-several-statements'));
    const migration = 'db/migrations/003_routes.sql';
    expect(rows(steps)).toEqual([
      `1 path ${id('src/main.ts', 'main')} <- ${id('src/main.ts', 'main')} : Body changed`,
      `2 migration ${id(migration, 'CREATE TABLE routes')} : Schema modified: CREATE TABLE routes`,
      `3 migration ${id(migration, 'ALTER TABLE crates')} : Schema modified: ALTER TABLE crates`,
      `4 migration ${id(migration, 'CREATE INDEX crates_route_idx')} : Schema modified: CREATE INDEX crates_route_idx`,
      `5 migration ${id('db/schema.sql', 'CREATE TABLE crates')} : Schema modified: CREATE TABLE crates`,
      `6 migration ${id('db/schema.sql', 'CREATE INDEX crates_weight_idx')} : Schema modified: CREATE INDEX crates_weight_idx`,
    ]);
    expect(steps.find((s) => s.symbolId === id('db/schema.sql', 'CREATE TABLE crates'))?.diff).toEqual([
      { kind: 'del', text: 'CREATE TABLE crates (id integer primary key, depot_id integer);' },
      { kind: 'add', text: 'CREATE TABLE crates (id integer primary key, depot_id integer, weight integer);' },
    ]);
  });

  it('tsx-component-tree: JSX elements are edges, walked breadth first in source order', async () => {
    const { steps } = await buildExecutionPath(await adversarial('tsx-component-tree'));
    const main = id('src/main.tsx', 'main');
    expect(rows(steps)).toEqual([
      `1 path ${main} <- ${main} : Signature changed`,
      `2 path ${id('src/App.tsx', 'App')} <- ${main} : New function`,
      `3 path ${id('src/Header.tsx', 'Header')} <- ${main} : New function`,
      `4 path ${id('src/List.tsx', 'List')} <- ${main} : New function`,
      `5 path ${id('src/Row.tsx', 'Row')} <- ${main} : New function`,
    ]);
  });

  it('moved-unchanged: symbols that only moved lines are same and give no step', async () => {
    const input = await adversarial('moved-unchanged');
    const depot = input.files.find((file) => file.path === 'src/depot.ts');
    expect(depot?.symbols.map((s) => [s.name, s.status])).toEqual([
      ['stamp', 'add'],
      ['label', 'same'],
      ['weigh', 'same'],
    ]);
    const { steps } = await buildExecutionPath(input);
    expect(rows(steps)).toEqual([`1 unconnected ${id('src/depot.ts', 'stamp')} : New function`]);
  });

  it('crlf: a CRLF file gives steps whose diff lines carry no carriage return, and its unchanged symbols no step', async () => {
    const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`;
    const before = {
      'src/depot.ts': crlf(['export function weigh(kg: number): number {', '  return kg;', '}', '', 'export function label(name: string): string {', '  return name;', '}']),
    };
    const after = {
      'src/depot.ts': crlf(['export function weigh(kg: number): number {', '  return kg * 2;', '}', '', 'export function label(name: string): string {', '  return name;', '}']),
    };
    const { steps } = await buildExecutionPath(await inMemoryPath(before, after));
    expect(rows(steps)).toEqual([`1 unconnected ${id('src/depot.ts', 'weigh')} : Body changed`]);
    expect(steps[0]?.diff).toEqual([
      { kind: 'ctx', text: 'export function weigh(kg: number): number {' },
      { kind: 'del', text: '  return kg;' },
      { kind: 'add', text: '  return kg * 2;' },
      { kind: 'ctx', text: '}' },
    ]);
  });

  it('crlf-only-line-endings: a file whose line endings alone turned from LF to CRLF gives no step', async () => {
    const lines = ['export function weigh(kg: number): number {', '  return kg;', '}'];
    const { steps } = await buildExecutionPath(
      await inMemoryPath({ 'src/depot.ts': `${lines.join('\n')}\n` }, { 'src/depot.ts': `${lines.join('\r\n')}\r\n` }),
    );
    expect(steps).toEqual([]);
  });

  it('renamed-modified: a renamed and modified file diffs each symbol against the old path, so only the changed one is a step', async () => {
    const built = await repoFromFixture('path/adversarial/renamed-modified');
    opened.push(built);
    const report: Report = await buildReport({
      repoDir: built.repo.dir,
      now: new Date('2026-10-07T08:00:00.000Z'),
      runner: ghForbidden().runner,
      trustConfig: true,
    });
    const file = report.packages.flatMap((pkg) => pkg.files).find((f) => f.path === 'src/shipments.ts');
    expect(file?.symbols.map((s) => [s.name, s.status])).toEqual([
      ['listParcels', 'same'],
      ['createParcel', 'mod'],
      ['countParcels', 'same'],
    ]);
    expect(report.steps).toEqual([
      {
        order: 1,
        symbolId: id('src/shipments.ts', 'createParcel'),
        fileId: 'src/shipments.ts',
        why: 'Body changed',
        diff: [
          { kind: 'ctx', text: 'export function createParcel(name: string): string {' },
          { kind: 'ctx', text: '  const trimmed = name.trim();' },
          { kind: 'del', text: '  return trimmed.toLowerCase();' },
          { kind: 'add', text: '  return trimmed.toUpperCase();' },
          { kind: 'ctx', text: '}' },
        ],
        section: 'unconnected',
      },
    ]);
  }, 60_000);
});
