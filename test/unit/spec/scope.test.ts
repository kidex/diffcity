// Spec scope (SPEC.md 5.5, ADR-035) on small invented trees under
// test/fixtures/spec/<case>/: roots by backticked name, by path and by route
// string; links through callers and callees among touched symbols; no root
// means nothing is claimed; untouched files stay null; and the verdict order
// of 5.2 with `spec` after `eyes` and `risky`.

import { describe, expect, it } from 'vitest';
import type { Finding } from '../../../src/core/report/types.js';
import { NO_ROOT_NOTICE, specScope, specTokens } from '../../../src/core/spec/index.js';
import { specCase } from '../../helpers/spec-fixture.js';

describe('spec scope roots (ADR-035)', () => {
  it('spec/root-by-backticked-symbol: a backticked qualified or base name roots the symbol', async () => {
    const { inSpec, scope } = await specCase('root-by-backticked-symbol');
    expect(scope.notice).toBeNull();
    expect(inSpec).toEqual({
      // `Oven.preheat`: the qualified name of the method.
      'src/bakery/oven.ts': true,
      // `riseDough`: the base name of the function.
      'src/bakery/proof.ts': true,
      'src/bakery/till.ts': false,
    });
  });

  it('spec/root-by-backticked-symbol: a backticked call, with or without arguments, names the callee', async () => {
    for (const text of ['`Oven.preheat()` and `riseDough(30)`.', '`Oven.preheat(degrees, 20)` and `riseDough()`.']) {
      expect((await specCase('root-by-backticked-symbol', { text })).inSpec, text).toEqual({
        'src/bakery/oven.ts': true,
        'src/bakery/proof.ts': true,
        'src/bakery/till.ts': false,
      });
    }
  });

  it('spec/root-by-backticked-symbol: anything else around the name keeps it exact', async () => {
    for (const text of ['`riseDough();`', '`new Oven.preheat()`', '`riseDough()()x`', '`riseDough(`', '`await riseDough()`', 'riseDough()']) {
      expect((await specCase('root-by-backticked-symbol', { text })).scope, text).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    }
  });

  it('spec/root-by-path: a repo-relative path in prose or a basename with a dot roots the file, symbols or not', async () => {
    const { inSpec } = await specCase('root-by-path');
    expect(inSpec).toEqual({
      // "run the build": a basename without a dot is no root (PO, 2026-10-13).
      'bin/run': false,
      // `menu.json`: basename of a touched file with no symbols.
      'config/menu.json': true,
      'src/bakery/oven.ts': false,
      'src/bakery/shelf.ts': false,
      // src/bakery/till.ts: the repo-relative path, ending a sentence in prose.
      'src/bakery/till.ts': true,
      // "in index.ts.": a basename with a dot, ending a sentence.
      'src/web/index.ts': true,
    });
  });

  it('spec/root-by-path: an extensionless file is rooted by its repo-relative path only', async () => {
    expect((await specCase('root-by-path', { text: 'Fix `run`.' })).scope).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    expect((await specCase('root-by-path', { text: 'Fix bin/run.' })).inSpec['bin/run']).toBe(true);
  });

  it('spec/root-by-path: the match is exact and case-sensitive', async () => {
    // Plain text is not resolved: `./` is only normalized in a link target.
    for (const text of ['Edit ./src/bakery/till.ts.', 'Edit SRC/bakery/till.ts.', 'Edit `Menu.json`.', 'Edit `till`.']) {
      const { scope } = await specCase('root-by-path', { text });
      expect(scope, text).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    }
  });

  it('spec/root-by-route-string: `POST /path` roots the touched symbol that registers the route and its handler', async () => {
    const { inSpec } = await specCase('root-by-route-string');
    expect(inSpec).toEqual({
      // sliceLoaf, the handler the new route names.
      'src/api/loaves.ts': true,
      // registerRoutes, which declares the route.
      'src/api/routes.ts': true,
      'src/bakery/till.ts': false,
    });
  });

  it('spec/root-by-route-string: a path ending in punctuation matches as written, and stripped before a full stop', () => {
    const file = (path: string, name: string) => ({ path, status: 'mod' as const, symbols: [{ id: `${path}#${name}`, name, status: 'mod' as const }] });
    const files = [file('src/app/orders/[id]/route.ts', 'GET'), file('src/api/files.ts', 'readFile'), file('src/bakery/till.ts', 'ringUp')];
    const routes = new Map([
      // A Next.js dynamic route (nextRoutePath) ends in `]`.
      ['src/app/orders/[id]/route.ts#GET', [{ method: 'GET', path: '/orders/[id]' }]],
      // An optional Express parameter ends in `?`.
      ['src/api/files.ts#readFile', [{ method: 'GET', path: '/files/:name?' }]],
    ]);
    const scope = (text: string) => specScope({ text, specPath: '.diffcity/spec.md', files, edges: new Map(), routes }).inSpec;
    const both = new Map([
      ['src/app/orders/[id]/route.ts', true],
      ['src/api/files.ts', true],
      ['src/bakery/till.ts', false],
    ]);
    expect(scope('Add `GET /orders/[id]` and `GET /files/:name?`.')).toEqual(both);
    expect(scope('Add GET /orders/[id] and GET /files/:name?')).toEqual(both);
    // Followed by sentence punctuation, the stripped form still matches.
    expect(scope('Add GET /orders/[id].\nThen GET /files/:name?.')).toEqual(both);
  });

  it('spec/root-by-route-string: another method, another path or lower case is no root', async () => {
    for (const text of ['`GET /loaves/:id/slice`', '`POST /loaves/:id`', '`post /loaves/:id/slice`', '`POST /loaves`']) {
      const { scope } = await specCase('root-by-route-string', { text });
      expect(scope, text).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    }
  });

  it('spec/prose-words-do-not-match: names in prose, or backticked in another case, are no roots', async () => {
    const { inSpec, scope } = await specCase('prose-words-do-not-match');
    expect(scope).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    expect(inSpec).toEqual({ 'src/bakery/oven.ts': null, 'src/bakery/shelf.ts': null, 'src/bakery/till.ts': null });
  });

  it('spec/prose-words-do-not-match: a backticked common identifier does match (the over-match ADR-035 accepts)', async () => {
    // `get` is the base name of Shelf.get: exact and backticked, so it roots it.
    const { inSpec } = await specCase('prose-words-do-not-match', { text: 'Fix `get`.\n' });
    expect(inSpec).toEqual({ 'src/bakery/oven.ts': false, 'src/bakery/shelf.ts': true, 'src/bakery/till.ts': false });
  });
});

describe('spec scope Markdown links (ADR-035, PO 2026-10-13)', () => {
  const till = { 'config/menu.json': false, 'src/bakery/oven.ts': false, 'src/bakery/shelf.ts': false, 'src/bakery/till.ts': true };

  it('spec/root-by-path: a link target resolves from the spec file directory, without fragment or query', async () => {
    for (const text of ['See [the till](../src/bakery/till.ts).', 'See [L10](../src/bakery/till.ts#L10).', 'See [raw](../src/bakery/till.ts?plain=1#L2).', 'See [t](<../src/bakery/./till.ts> "the till").']) {
      const { inSpec } = await specCase('root-by-path', { text });
      expect(inSpec, text).toMatchObject(till);
      expect(inSpec['bin/run'], text).toBe(false);
    }
  });

  it('spec/root-by-path: from .diffcity/spec.md, a target written from the repo root or with ./ points under .diffcity/, and a target out of the repo is ignored', async () => {
    for (const text of ['[t](src/bakery/till.ts)', '[t](./src/bakery/till.ts)', '[t](../../src/bakery/till.ts)', '[t](/src/bakery/till.ts)', '[t](https://example.invalid/src/bakery/till.ts)']) {
      expect((await specCase('root-by-path', { text })).scope, text).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    }
  });

  it('spec/root-by-path: a --spec file resolves its links from its own directory, inside or outside the repo', async () => {
    // At the repo root: `./` is stripped.
    const atRoot = { root: '/work/bakery', dir: '/work/bakery' };
    expect((await specCase('root-by-path', { text: '[t](./src/bakery/till.ts#L3)', specPath: 'task.md', linkBase: atRoot })).inSpec).toMatchObject(till);
    // Next to the repo, in /work/tasks: back up and into the repo.
    const beside = { root: '/work/bakery', dir: '/work/tasks' };
    expect((await specCase('root-by-path', { text: '[t](../bakery/src/bakery/till.ts)', specPath: null, linkBase: beside })).inSpec).toMatchObject(till);
    expect((await specCase('root-by-path', { text: '[t](../other/src/bakery/till.ts)', specPath: null, linkBase: beside })).scope).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
  });

  it('a link text is prose: only its target counts', async () => {
    expect((await specCase('root-by-path', { text: '[src/bakery/till.ts](../src/bakery/oven.ts)' })).inSpec).toMatchObject({
      'src/bakery/oven.ts': true,
      'src/bakery/till.ts': true,
    });
    expect((await specCase('root-by-path', { text: '[the till](src/bakery/till.ts)' })).scope.inSpec).toBeNull();
  });
});

describe('spec scope links (ADR-035)', () => {
  it('spec/connected-through-callers: the callers of a root, transitively, are in the spec', async () => {
    // `stoke` is called by bake, which openShop calls.
    const { inSpec } = await specCase('connected-through-callers');
    expect(inSpec).toEqual({
      'src/bakery/fire.ts': true,
      'src/bakery/oven.ts': true,
      'src/bakery/shop.ts': true,
      'src/bakery/till.ts': false,
    });
  });

  it('spec/connected-through-callees: the callees of a root, transitively, are in the spec', async () => {
    // `openShop` calls bake, which calls stoke.
    const { inSpec } = await specCase('connected-through-callees');
    expect(inSpec).toEqual({
      'src/bakery/fire.ts': true,
      'src/bakery/oven.ts': true,
      'src/bakery/shop.ts': true,
      'src/bakery/till.ts': false,
    });
  });

  it('spec/unconnected-file-outside: a touched file with no link is false, also when its only link is an untouched symbol', async () => {
    // bake calls weigh, which is untouched: scale.ts's touched symbol (tare) has no link to the root.
    const { inSpec } = await specCase('unconnected-file-outside');
    expect(inSpec).toEqual({ 'src/bakery/oven.ts': true, 'src/bakery/scale.ts': false, 'src/bakery/till.ts': false });
  });
});

describe('spec scope nulls (ADR-035)', () => {
  it('spec/no-root-matched-null: a spec naming nothing touched leaves every file null, with the notice', async () => {
    const { inSpec, scope, report } = await specCase('no-root-matched-null');
    expect(scope).toEqual({ inSpec: null, notice: 'The spec names no touched symbol or file' });
    expect(inSpec).toEqual({ 'src/bakery/oven.ts': null, 'src/bakery/till.ts': null });
    expect(report.specNotice).toBe('The spec names no touched symbol or file');
    expect(report.summary.byVerdict.spec).toBe(0);
  });

  it('spec/no-root-matched-null: an empty spec or one in prose only says so too', async () => {
    for (const text of ['', '# Spec\n\nMake the bakery better.\n']) {
      expect((await specCase('no-root-matched-null', { text })).scope).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    }
  });

  it('spec/absent-null: without a spec there is no scope, no notice and no spec verdict', async () => {
    const { report } = await specCase('absent', { text: '' });
    // assembleReport without a scope is the no-spec Report.
    const { assembleReport } = await import('../../../src/core/report/build.js');
    const none = assembleReport(report.meta, report.packages.flatMap((pkg) => pkg.files), () => false);
    expect(none.packages.flatMap((pkg) => pkg.files).map((file) => file.inSpec)).toEqual([null, null]);
    expect(none.summary.byVerdict.spec).toBe(0);
    expect('specNotice' in none).toBe(false);
  });

  it('spec/untouched-null: untouched files stay null, and naming an untouched symbol or file roots nothing', async () => {
    const { inSpec } = await specCase('untouched-null');
    expect(inSpec).toEqual({ 'src/bakery/oven.ts': true, 'src/bakery/scale.ts': null, 'src/bakery/till.ts': false });
    // Only the untouched names: no root.
    const only = await specCase('untouched-null', { text: 'Keep `weigh` and src/bakery/scale.ts.\n' });
    expect(only.scope).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
  });

  it('the spec file itself is in the spec when touched, and naming itself is no root', () => {
    const files = [
      { path: '.diffcity/spec.md', status: 'add' as const, symbols: [] },
      { path: 'src/bakery/oven.ts', status: 'mod' as const, symbols: [{ id: 'src/bakery/oven.ts#bake', name: 'bake', status: 'mod' as const }] },
    ];
    const base = { specPath: '.diffcity/spec.md', files, edges: new Map(), routes: new Map() };
    expect(specScope({ ...base, text: 'Bake longer in `bake`.' }).inSpec).toEqual(
      new Map([
        ['.diffcity/spec.md', true],
        ['src/bakery/oven.ts', true],
      ]),
    );
    expect(specScope({ ...base, text: 'This is `.diffcity/spec.md` and `spec.md`.' })).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
    expect(specScope({ ...base, text: 'Nothing here.' })).toEqual({ inSpec: null, notice: NO_ROOT_NOTICE });
  });
});

describe('spec verdict (SPEC.md 5.2)', () => {
  const high: Finding = {
    id: 'rule:file-size:src/bakery/till.ts',
    source: 'rule:file-size',
    severity: 'high',
    category: 'architecture',
    file: 'src/bakery/till.ts',
    line: 1,
    title: 'File too large',
    message: 'The till is too large.',
    state: 'open',
  };

  it('spec/verdict-spec-after-eyes-and-risky: outside the spec, tier 1 and sig stay eyes, an open high finding stays risky', async () => {
    const { report, inSpec } = await specCase('verdict-spec-after-eyes-and-risky', { findings: [high] });
    expect(inSpec).toEqual({
      'src/auth/door.ts': false,
      'src/bakery/oven.ts': true,
      'src/bakery/scale.ts': false,
      'src/bakery/shelf.ts': false,
      'src/bakery/till.ts': false,
    });
    const verdicts = Object.fromEntries(report.packages.flatMap((pkg) => pkg.files.map((file) => [file.path, file.verdict])));
    expect(verdicts).toEqual({
      // Tier 1 (`auth`) beats spec.
      'src/auth/door.ts': 'eyes',
      'src/bakery/oven.ts': 'ok',
      // A sig symbol beats spec.
      'src/bakery/scale.ts': 'eyes',
      // Outside the spec, nothing above: spec.
      'src/bakery/shelf.ts': 'spec',
      // An open high finding beats spec.
      'src/bakery/till.ts': 'risky',
    });
    expect(report.summary.byVerdict).toEqual({ eyes: 2, risky: 1, spec: 1, ok: 1, same: 0 });
  });

  it('spec/verdict-spec-after-eyes-and-risky: an intended high finding no longer hides the spec verdict', async () => {
    const { report } = await specCase('verdict-spec-after-eyes-and-risky', { findings: [{ ...high, state: 'intended' }] });
    expect(report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === 'src/bakery/till.ts')?.verdict).toBe('spec');
  });
});

describe('spec tokens', () => {
  it('identifiers come from inline code spans only; words and routes from the text outside link targets', () => {
    const tokens = specTokens('Use `alpha` and ``beta`` in ```\ngamma\n```, see (src/a.ts), [b](src/b.ts) and `PUT /x/:id`.', { root: '/r', dir: '/r/.diffcity' });
    expect([...tokens.code]).toEqual(['alpha', 'PUT /x/:id']);
    expect(tokens.words.has('src/a.ts')).toBe(true);
    expect(tokens.words.has('src/b.ts')).toBe(false);
    expect([...tokens.links]).toEqual(['.diffcity/src/b.ts']);
    expect([...tokens.routes]).toEqual(['PUT /x/:id']);
  });
});
