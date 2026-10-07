// The execution path (SPEC.md 5.4, ADR-034) over small invented trees under
// test/fixtures/path/: entry points, order, sections, `why` and Step.diff.

import { describe, expect, it } from 'vitest';
import { STEP_GAP, STEP_MAX_LINES, stepDiff } from '../../src/core/path/diff.js';
import { mayRegisterEntries } from '../../src/core/path/entries.js';
import { buildExecutionPath, type ExecutionPath } from '../../src/core/path/order.js';
import { applyWhyOverrides } from '../../src/core/path/why.js';
import type { Step } from '../../src/core/report/types.js';
import { fixturePath, id } from '../helpers/path-fixture.js';

async function pathOf(name: string): Promise<ExecutionPath> {
  return buildExecutionPath(await fixturePath(name));
}

/** `order section symbolId <- entry : why`, one string per step. */
function rows(steps: readonly Step[]): string[] {
  return steps.map(
    (step) => `${String(step.order)} ${step.section ?? 'path'} ${step.symbolId}${step.entry === undefined ? '' : ` <- ${step.entry}`} : ${step.why}`,
  );
}

function step(steps: readonly Step[], symbolId: string): Step {
  const found = steps.find((s) => s.symbolId === symbolId);
  if (found === undefined) throw new Error(`no step for ${symbolId}: ${rows(steps).join('\n')}`);
  return found;
}

describe('entry', () => {
  it('entry/express-route-added: a registration that gains a route is the first entry, named after the new route', async () => {
    const { steps } = await pathOf('entry/express-route-added');
    const register = id('src/server.ts', 'registerRoutes');
    const create = id('src/items.ts', 'createItem');
    expect(rows(steps)).toEqual([
      `1 path ${register} <- ${register} : New endpoint POST /items`,
      // The handler passed by name is a controller handler (class 2), an entry of its own.
      `2 path ${create} <- ${create} : New function`,
    ]);
  });

  it('express-route-handler-modified: an unchanged registration with a modified handler makes the handler the route entry', async () => {
    const { steps } = await pathOf('entry/express-route-handler-modified');
    const list = id('src/items.ts', 'listItems');
    expect(rows(steps)).toEqual([`1 path ${list} <- ${list} : Endpoint changed: GET /items`]);
  });

  it('nest-controller-method: decorated methods of a @Controller class are routes with the controller prefix', async () => {
    const { steps } = await pathOf('entry/nest-controller-method');
    const find = id('src/invoices.controller.ts', 'InvoicesController.find');
    const create = id('src/invoices.controller.ts', 'InvoicesController.create');
    expect(rows(steps)).toEqual([
      `1 path ${find} <- ${find} : Endpoint changed: GET /invoices/:id`,
      `2 path ${create} <- ${create} : New endpoint POST /invoices`,
    ]);
  });

  it('next-route-export: exports of route.ts named after an HTTP method are routes on the directory path', async () => {
    const { steps } = await pathOf('entry/next-route-export');
    const file = 'app/(shop)/api/tickets/route.ts';
    expect(rows(steps)).toEqual([
      `1 path ${id(file, 'GET')} <- ${id(file, 'GET')} : Endpoint changed: GET /api/tickets`,
      `2 path ${id(file, 'POST')} <- ${id(file, 'POST')} : New endpoint POST /api/tickets`,
    ]);
  });

  it('controller-class-handler: methods of a *Controller class are entries; its constructor and other classes are not', async () => {
    const { steps } = await pathOf('entry/controller-class-handler');
    const file = 'src/billing.controller.ts';
    expect(rows(steps)).toEqual([
      `1 path ${id(file, 'BillingController.refund')} <- ${id(file, 'BillingController.refund')} : Body changed`,
      // The class heads did not change (same, no step); the constructor is not a handler.
      `2 unconnected ${id(file, 'BillingController.constructor')} : Body changed`,
      `3 unconnected ${id(file, 'BillingHelper.calc')} : Body changed`,
    ]);
  });

  it('main-function: a function named main is an entry and its touched callees follow it', async () => {
    const { steps } = await pathOf('entry/main-function');
    const main = id('src/tool.ts', 'main');
    expect(rows(steps)).toEqual([
      `1 path ${main} <- ${main} : Body changed`,
      `2 path ${id('src/args.ts', 'parseArgs')} <- ${main} : New function`,
    ]);
  });

  it('package-bin: the symbols of a file named in package.json bin are entries (JS, name matching)', async () => {
    const { steps } = await pathOf('entry/package-bin');
    const start = id('bin/tally.js', 'start');
    expect(rows(steps)).toEqual([
      `1 path ${start} <- ${start} : Body changed`,
      `2 path ${id('lib/count.js', 'count')} <- ${start} : New function`,
    ]);
  });

  it('commander-action: a handler passed to .action() is an entry, and so is the symbol holding an inline one', async () => {
    const { steps } = await pathOf('entry/commander-action');
    const setup = id('src/cli.ts', 'setup');
    const setupSync = id('src/cli.ts', 'setupSync');
    const runExport = id('src/export.ts', 'runExport');
    expect(rows(steps)).toEqual([
      `1 path ${setupSync} <- ${setupSync} : New function`,
      `2 path ${runExport} <- ${runExport} : New function`,
      // Registering a handler by name is not a call: setup reaches nothing and no rule claims it.
      `3 unconnected ${setup} : Body changed`,
    ]);
  });

  it('cron-job: a cron.schedule handler and a @Cron method are scheduled-job entries', async () => {
    const { steps } = await pathOf('entry/cron-job');
    const cleanup = id('src/jobs.ts', 'nightlyCleanup');
    const sweep = id('src/sweeper.ts', 'Sweeper.sweep');
    expect(rows(steps)).toEqual([
      `1 path ${cleanup} <- ${cleanup} : Body changed`,
      `2 path ${sweep} <- ${sweep} : New method`,
      `3 unconnected ${id('src/sweeper.ts', 'Sweeper')} : New class`,
    ]);
  });

  it('new-test: added symbols of a test file are entries, "New test", and the code they call hangs from them', async () => {
    const { steps } = await pathOf('entry/new-test');
    const sample = id('test/sum.test.ts', 'sample');
    const block = id('test/sum.test.ts', 'adds numbers');
    expect(rows(steps)).toEqual([
      `1 path ${sample} <- ${sample} : New test`,
      `2 path ${block} <- ${block} : New test`,
      `3 path ${id('src/sum.ts', 'sum')} <- ${block} : Body changed`,
    ]);
  });

  it('client-call-not-a-route: a call with a path and no handler (an HTTP client, an app setting) registers no route', async () => {
    const { steps } = await pathOf('entry/client-call-not-a-route');
    expect(rows(steps)).toEqual([
      `1 unconnected ${id('src/client.ts', 'loadUsers')} : Body changed`,
      `2 unconnected ${id('src/settings.ts', 'mode')} : Body changed`,
    ]);
    expect(mayRegisterEntries("const users = await api.get('/users');")).toBe(false);
    expect(mayRegisterEntries("const env = app.get('env');")).toBe(false);
    expect(mayRegisterEntries("app.get('/items', listItems);")).toBe(true);
    expect(mayRegisterEntries('router.post(`/items`, (req, res) => res.end());')).toBe(true);
  });

  it('priority-route-before-main: routes, then main, then new tests, whatever the file order', async () => {
    const { steps } = await pathOf('entry/priority-route-before-main');
    expect(steps.map((s) => [s.symbolId, s.entry])).toEqual([
      [id('src/z-routes.ts', 'registerRoutes'), id('src/z-routes.ts', 'registerRoutes')],
      [id('src/a-main.ts', 'main'), id('src/a-main.ts', 'main')],
      [id('src/b.test.ts', 'starts'), id('src/b.test.ts', 'starts')],
    ]);
    expect(steps[0]?.why).toBe('Endpoint changed: GET /status');
  });
});

describe('order', () => {
  it('order/bfs-callee-source-order: breadth first, callees in the order of their calls in the source', async () => {
    const { steps } = await pathOf('order/bfs-callee-source-order');
    expect(steps.map((s) => s.symbolId)).toEqual([
      id('src/main.ts', 'main'),
      id('src/steps.ts', 'gamma'),
      id('src/steps.ts', 'alpha'),
      id('src/steps.ts', 'beta'),
      id('src/deep.ts', 'delta'),
    ]);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(steps.map((s) => s.entry))).toEqual(new Set([id('src/main.ts', 'main')]));
  });

  it('symbol-once-at-first-visit: a symbol two entries reach is one step, under the first entry', async () => {
    const { steps } = await pathOf('order/symbol-once-at-first-visit');
    const main = id('src/main.ts', 'main');
    const shared = id('src/shared.ts', 'shared');
    const test = id('src/shared.test.ts', 'shares');
    expect(rows(steps)).toEqual([
      `1 path ${main} <- ${main} : Body changed`,
      `2 path ${shared} <- ${main} : Body changed`,
      `3 path ${test} <- ${test} : New test`,
    ]);
  });

  it('sql-after-last-repo-symbol: touched SQL statements come after the path, before Unconnected, in file then range order', async () => {
    const { steps } = await pathOf('order/sql-after-last-repo-symbol');
    const file = 'db/migrations/002_ledger_names.sql';
    expect(rows(steps)).toEqual([
      `1 path ${id('src/main.ts', 'main')} <- ${id('src/main.ts', 'main')} : Body changed`,
      `2 path ${id('src/repo.ts', 'saveLedger')} <- ${id('src/main.ts', 'main')} : New function`,
      `3 migration ${id(file, 'ALTER TABLE ledgers')} : Schema modified: ALTER TABLE ledgers`,
      `4 migration ${id(file, 'CREATE INDEX ledgers_name_idx')} : Schema modified: CREATE INDEX ledgers_name_idx`,
      `5 unconnected ${id('src/stray.ts', 'stray')} : New function`,
    ]);
    // The untouched migration gives no step.
    expect(steps.some((s) => s.fileId === 'db/migrations/001_ledgers.sql')).toBe(false);
  });

  it('unconnected-last: symbols no entry reaches close the list in file then range order, removed ones included', async () => {
    const { steps } = await pathOf('order/unconnected-last');
    const main = id('src/main.ts', 'main');
    expect(rows(steps)).toEqual([
      `1 path ${main} <- ${main} : Body changed`,
      `2 path ${id('src/reached.ts', 'reached')} <- ${main} : New function`,
      `3 unconnected ${id('src/a-loose.ts', 'earlier')} : Body changed`,
      `4 unconnected ${id('src/b-loose.ts', 'looseOne')} : Body changed`,
      // A removed symbol is placed by its before range (line 5), looseTwo by its after range (line 5): the id breaks the tie.
      `5 unconnected ${id('src/b-loose.ts', 'looseTwo')} : Body changed`,
      `6 unconnected ${id('src/b-loose.ts', 'retired')} : Removed function`,
    ]);
  });

  it('same-symbols-excluded: a same symbol is no step, is never walked through and never starts an entry', async () => {
    const { steps } = await pathOf('order/same-symbols-excluded');
    const main = id('src/main.ts', 'main');
    expect(rows(steps)).toEqual([
      // OtherController.handle is same: only its modified sibling is an entry (controller handlers come before main).
      `1 path ${id('src/other.controller.ts', 'OtherController.extra')} <- ${id('src/other.controller.ts', 'OtherController.extra')} : Body changed`,
      `2 path ${main} <- ${main} : Body changed`,
      // deep is called only through the same steady(): not reached.
      `3 unconnected ${id('src/deep.ts', 'deep')} : Body changed`,
      `4 unconnected ${id('src/steady.ts', 'touched')} : Body changed`,
    ]);
    expect(steps.some((s) => s.symbolId.endsWith('#steady') || s.symbolId.endsWith('#OtherController.handle'))).toBe(false);
  });

  it('deterministic-two-runs: the same change gives the same steps, whatever the order of the input files', async () => {
    const input = await fixturePath('order/sql-after-last-repo-symbol');
    const first = await buildExecutionPath(input);
    const second = await buildExecutionPath({ ...input, files: [...input.files].reverse() });
    expect(JSON.stringify(second.steps)).toBe(JSON.stringify(first.steps));
    expect([...second.callsites]).toEqual([...first.callsites]);
  });
});

describe('why', () => {
  it('why/new-endpoint: a new route reads "New endpoint <METHOD> <path>"', async () => {
    const { steps } = await pathOf('entry/express-route-added');
    expect(step(steps, id('src/server.ts', 'registerRoutes')).why).toBe('New endpoint POST /items');
  });

  it('sig-with-callsites: a signature change counts the calls rewritten in touched files', async () => {
    const { steps, callsites } = await pathOf('why/sig-with-callsites');
    const price = id('src/price.ts', 'price');
    expect(callsites.get(price)).toBe(3);
    expect(step(steps, price).why).toBe('Signature changed, 3 call sites rewritten');
  });

  it('schema-modified: an added or modified SQL statement reads "Schema modified: <statement>"', async () => {
    const { steps } = await pathOf('why/schema-modified');
    expect(rows(steps)).toEqual([
      `1 migration ${id('db/schema.sql', 'CREATE TABLE ledgers')} : Schema modified: CREATE TABLE ledgers`,
      `2 migration ${id('db/schema.sql', 'CREATE INDEX ledgers_name_idx')} : Schema modified: CREATE INDEX ledgers_name_idx`,
    ]);
  });

  it('override-from-finding: a why hint replaces the rule text of its symbol only, without changing the input', async () => {
    const { steps } = await pathOf('order/sql-after-last-repo-symbol');
    const repo = id('src/repo.ts', 'saveLedger');
    const before = JSON.stringify(steps);
    const overridden = applyWhyOverrides(steps, new Map([[repo, 'Writes the ledger row the new column needs.']]));
    expect(step(overridden, repo).why).toBe('Writes the ledger row the new column needs.');
    expect(overridden.filter((s) => s.symbolId !== repo)).toEqual(steps.filter((s) => s.symbolId !== repo));
    expect(JSON.stringify(steps)).toBe(before);
    expect(applyWhyOverrides(steps, new Map())).toEqual(steps);
  });
});

describe('diff', () => {
  it('diff/step-new-symbol-all-add: a new symbol shows every line as add', async () => {
    expect(stepDiff('add', null, ['export function a() {', '  return 1;', '}'])).toEqual([
      { kind: 'add', text: 'export function a() {' },
      { kind: 'add', text: '  return 1;' },
      { kind: 'add', text: '}' },
    ]);
    expect(stepDiff('del', ['gone();'], null)).toEqual([{ kind: 'del', text: 'gone();' }]);
    const { steps } = await pathOf('entry/express-route-added');
    expect(step(steps, id('src/items.ts', 'createItem')).diff).toEqual([
      { kind: 'add', text: 'export function createItem(name: string): string {' },
      { kind: 'add', text: '  return name.trim();' },
      { kind: 'add', text: '}' },
    ]);
  });

  it('step-mod-context: a modified symbol shows the changed lines with three lines of context on each side', async () => {
    const { steps } = await pathOf('diff/step-mod-context');
    expect(step(steps, id('src/long.ts', 'long')).diff).toEqual([
      { kind: 'ctx', text: '  const v7 = 7;' },
      { kind: 'ctx', text: '  const v8 = 8;' },
      { kind: 'ctx', text: '  const v9 = 9;' },
      { kind: 'del', text: '  const v10 = 10;' },
      { kind: 'add', text: '  const v10 = 100;' },
      { kind: 'ctx', text: '  const v11 = 11;' },
      { kind: 'ctx', text: '  const v12 = 12;' },
      { kind: 'ctx', text: '  const v13 = 13;' },
    ]);
    // Two changes far apart: the unchanged run between them is one gap line.
    const before = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`);
    const after = before.map((line, i) => (i === 2 || i === 17 ? `${line}!` : line));
    const diff = stepDiff('mod', before, after);
    expect(diff.filter((line) => line.text === STEP_GAP)).toEqual([{ kind: 'ctx', text: STEP_GAP }]);
    expect(diff.filter((line) => line.kind !== 'ctx').map((line) => line.text)).toEqual(['line 2', 'line 2!', 'line 17', 'line 17!']);
  });

  it('step-cap-120: a longer diff stops at 120 lines, the last one "... N more lines"', () => {
    const after = Array.from({ length: 200 }, (_, i) => `row ${String(i)}`);
    const diff = stepDiff('add', null, after);
    expect(diff).toHaveLength(STEP_MAX_LINES);
    expect(diff.slice(0, 119).every((line) => line.kind === 'add')).toBe(true);
    expect(diff[119]).toEqual({ kind: 'ctx', text: '... 81 more lines' });
    expect(stepDiff('add', null, after.slice(0, 120))).toHaveLength(120);
    expect(stepDiff('add', null, after.slice(0, 120)).at(-1)).toEqual({ kind: 'add', text: 'row 119' });
  });
});
