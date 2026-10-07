// The execution path inside the Report (ADR-034): assembleReport places the
// steps and Symbol.callsites, buildReport computes them from a temp repo, and
// the steps are part of the content hash.

import { afterEach, describe, expect, it } from 'vitest';
import { assembleReport, buildReport } from '../../src/core/report/build.js';
import { contentHashOf } from '../../src/core/report/snapshot.js';
import type { Report, Step, Symbol } from '../../src/core/report/types.js';
import { repoFromFixture, type FixtureRepo } from '../helpers/fixture-repo.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';

isolateGitConfig();

const opened: FixtureRepo[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.repo.cleanup();
});

const NOW = new Date('2026-10-07T08:00:00.000Z');
const META: Report['meta'] = { repo: 'ledgerline', base: 'main', head: 'feature/work', commits: 1, generatedAt: NOW.toISOString() };

async function repoOf(fixture: string, commit = true): Promise<string> {
  const built = await repoFromFixture(`path/${fixture}`, { commit });
  opened.push(built);
  return built.repo.dir;
}

function build(repoDir: string): Promise<Report> {
  return buildReport({ repoDir, now: NOW, runner: ghForbidden().runner, trustConfig: true });
}

async function reportOf(fixture: string, commit = true): Promise<Report> {
  return build(await repoOf(fixture, commit));
}

const symbolsOf = (report: Report): Symbol[] => report.packages.flatMap((pkg) => pkg.files.flatMap((file) => file.symbols));

describe('report', () => {
  it('report/steps-in-content-hash: the steps are hashed with the rest of the report', () => {
    const symbol: Symbol = { id: 'src/a.ts#run', name: 'run', kind: 'function', status: 'sig', range: { start: 1, end: 3 } };
    const inputs = [{ path: 'src/a.ts', language: 'typescript', status: 'sig' as const, symbols: [symbol] }];
    const step: Step = { order: 1, symbolId: symbol.id, fileId: 'src/a.ts', why: 'Signature changed', diff: [], section: 'unconnected' };
    const withStep = assembleReport(META, inputs, () => false, { steps: [step], callsites: new Map([[symbol.id, 2]]) });
    const again = assembleReport(META, inputs, () => false, { steps: [{ ...step }], callsites: new Map([[symbol.id, 2]]) });
    const otherWhy = assembleReport(META, inputs, () => false, { steps: [{ ...step, why: 'Body changed' }], callsites: new Map([[symbol.id, 2]]) });
    const none = assembleReport(META, inputs, () => false);

    expect(withStep.steps).toEqual([step]);
    expect(symbolsOf(withStep)[0]?.callsites).toBe(2);
    // assembleReport does not write into the symbols it was given.
    expect(symbol.callsites).toBeUndefined();
    expect(none.steps).toEqual([]);
    expect(symbolsOf(none)[0]?.callsites).toBe(0);
    expect(contentHashOf(again)).toBe(contentHashOf(withStep));
    expect(contentHashOf(otherWhy)).not.toBe(contentHashOf(withStep));
    expect(contentHashOf(none)).not.toBe(contentHashOf(withStep));
  });

  it('report/steps-deterministic: two builds of one change give the same steps and the same hash', async () => {
    const dir = await repoOf('order/sql-after-last-repo-symbol');
    const first = await build(dir);
    const second = await build(dir);
    expect(first.steps.map((step) => [step.order, step.symbolId, step.section])).toEqual([
      [1, 'src/main.ts#main', 'path'],
      [2, 'src/repo.ts#saveLedger', 'path'],
      [3, 'db/migrations/002_ledger_names.sql#ALTER TABLE ledgers', 'migration'],
      [4, 'db/migrations/002_ledger_names.sql#CREATE INDEX ledgers_name_idx', 'migration'],
      [5, 'src/stray.ts#stray', 'unconnected'],
    ]);
    expect(JSON.stringify(second.steps)).toBe(JSON.stringify(first.steps));
    expect(contentHashOf(second)).toBe(contentHashOf(first));
  }, 60_000);

  it('report/callsites-and-untouched-registration: sig symbols carry callsites; an untouched route file makes a handler an entry', async () => {
    const sig = await reportOf('why/sig-with-callsites');
    const price = symbolsOf(sig).find((symbol) => symbol.id === 'src/price.ts#price');
    expect(price?.callsites).toBe(3);
    expect(sig.steps.find((step) => step.symbolId === 'src/price.ts#price')?.why).toBe('Signature changed, 3 call sites rewritten');

    // Working-tree mode: the registration in src/server.ts is untouched, the handler changed.
    const route = await reportOf('entry/express-route-handler-modified', false);
    expect(route.steps).toEqual([
      {
        order: 1,
        symbolId: 'src/items.ts#listItems',
        fileId: 'src/items.ts',
        why: 'Endpoint changed: GET /items',
        diff: [
          { kind: 'ctx', text: 'export function listItems(): string[] {' },
          { kind: 'del', text: "  return ['kettle'];" },
          { kind: 'add', text: "  return ['kettle', 'teapot'];" },
          { kind: 'ctx', text: '}' },
        ],
        section: 'path',
        entry: 'src/items.ts#listItems',
      },
    ]);
  }, 60_000);
});
