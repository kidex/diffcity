import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Node as MorphNode } from 'ts-morph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCallGraph,
  loadTsMorph,
  readTsconfigPaths,
  MAX_TS_MORPH_FILES,
  type CallGraph,
  type GraphFile,
} from '../../src/core/path/graph.js';
import { fixtureChange, id } from '../helpers/path-fixture.js';

/** The edges as `from -> to` strings, in graph order. */
function edgeList(graph: CallGraph): string[] {
  return [...graph.edges].flatMap(([from, list]) => list.map((edge) => `${from} -> ${edge.to}`));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('graph', () => {
  it('graph/ts-direct-call: a call to a touched function is an edge', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-direct-call'));
    expect(graph.mode).toBe('ts-morph');
    expect(edgeList(graph)).toEqual([`${id('src/a.ts', 'run')} -> ${id('src/b.ts', 'helper')}`]);
  });

  it('graph/ts-method-call-through-type: a method call resolves through the receiver type', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-method-call-through-type'));
    const record = id('src/ledger.ts', 'Ledger.record');
    expect(edgeList(graph)).toEqual([
      `${id('src/desk.ts', 'Desk.close')} -> ${record}`,
      `${id('src/desk.ts', 'post')} -> ${record}`,
    ]);
  });

  it('graph/ts-renamed-import: aliased and namespace imports resolve to the original declaration', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-renamed-import'));
    const compute = id('src/math.ts', 'compute');
    expect(edgeList(graph)).toEqual([
      `${id('src/ns.ts', 'viaNamespace')} -> ${compute}`,
      `${id('src/user.ts', 'viaAlias')} -> ${compute}`,
    ]);
  });

  it('graph/ts-new-expression: new X() is an edge to the class, and the method call an edge to the method', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-new-expression'));
    const edges = graph.edges.get(id('src/load.ts', 'load')) ?? [];
    expect(edges.map((edge) => edge.to)).toEqual([id('src/parser.ts', 'Parser'), id('src/parser.ts', 'Parser.parse')]);
    expect(edges[0]?.pos).toBeLessThan(edges[1]?.pos ?? 0);
  });

  it('graph/ts-jsx-element: a component in JSX is an edge, once per caller, and a tag like div is not', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-jsx-element'));
    expect(edgeList(graph)).toEqual([`${id('src/page.tsx', 'Page')} -> ${id('src/card.tsx', 'Card')}`]);
  });

  it('graph/ts-untouched-intermediate-no-edge: A calling untouched U that calls B gives no edge A to B', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-untouched-intermediate-no-edge'));
    expect(edgeList(graph)).toEqual([]);
  });

  it('graph/ts-tsconfig-paths-star: an alias from the root tsconfig paths resolves', async () => {
    const input = await fixtureChange('graph/ts-tsconfig-paths-star');
    expect(edgeList(await buildCallGraph(input))).toEqual([`${id('src/app.ts', 'title')} -> ${id('src/lib/util.ts', 'slug')}`]);
    expect(edgeList(await buildCallGraph({ ...input, tsconfig: null }))).toEqual([]);
  });

  it('graph/js-name-match: a callee name that matches one touched symbol in an imported file, or in the same file, is an edge', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/js-name-match'));
    expect(graph.mode).toBe('names');
    expect(graph.edges.get(id('src/checkout.js', 'checkout'))?.map((edge) => edge.to)).toEqual([
      id('src/checkout.js', 'round'),
      id('src/tax.mjs', 'vat'),
      id('src/cart.js', 'Cart.total'),
    ]);
  });

  it('graph/js-ambiguous-name-no-edge: a name that matches two symbols in the imported files makes no edge', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/js-ambiguous-name-no-edge'));
    expect(edgeList(graph)).toEqual([`${id('src/main.js', 'render')} -> ${id('src/a.js', 'only')}`]);
  });

  it('graph/callsites-count-sig-only: call expressions resolving to a sig symbol are counted, other statuses are not', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/callsites-count-sig-only'));
    // Two calls inside quote and one at the top level of app.ts.
    expect([...graph.callsites]).toEqual([[id('src/price.ts', 'price'), 3]]);
    expect(graph.callsites.has(id('src/price.ts', 'fee'))).toBe(false);
    expect(graph.edges.get(id('src/app.ts', 'quote'))?.map((edge) => edge.to)).toEqual([
      id('src/price.ts', 'price'),
      id('src/price.ts', 'fee'),
    ]);
  });

  it('graph/callsites-count-sig-only (names): call sites are counted in JS too', async () => {
    const input = await fixtureChange('graph/js-name-match');
    const files = input.files.map(
      (file): GraphFile => ({
        ...file,
        symbols: file.symbols.map((symbol) => (symbol.name === 'vat' ? { ...symbol, status: 'sig' } : symbol)),
      }),
    );
    const graph = await buildCallGraph({ ...input, files });
    expect([...graph.callsites]).toEqual([[id('src/tax.mjs', 'vat'), 1]]);
  });
});

describe('graph/ts-fails-midway', () => {
  /** Makes the type checker throw on the callees of `path` (all files when `null`); files sorted before it go through first. */
  async function failOn(path: string | null): Promise<void> {
    const { Node } = await loadTsMorph();
    const original = Object.getOwnPropertyDescriptor(Node.prototype, 'getSymbol')?.value as (this: MorphNode) => ReturnType<MorphNode['getSymbol']>;
    vi.spyOn(Node.prototype, 'getSymbol').mockImplementation(function (this: MorphNode) {
      if (path === null || this.getSourceFile().getFilePath().endsWith(`/${path}`)) throw new Error('checker failed');
      return original.call(this);
    });
  }

  it('graph/ts-fails-midway: a ts-morph failure after some files leaves exactly the names-only graph', async () => {
    const input = await fixtureChange('graph/ts-fails-midway');
    const quote = id('src/a.ts', 'quote');
    const price = id('src/price.ts', 'price');
    const record = id('src/ledger.ts', 'Ledger.record');

    // Control: the checker alone sees the method call through the re-exported type.
    const full = await buildCallGraph(input);
    expect(full.mode).toBe('ts-morph');
    expect(edgeList(full)).toEqual([`${quote} -> ${record}`, `${quote} -> ${price}`, `${id('src/z.ts', 'tail')} -> ${price}`]);
    expect([...full.callsites]).toEqual([[price, 3]]);

    await failOn(null);
    const names = await buildCallGraph(input);
    vi.restoreAllMocks();
    expect(names.mode).toBe('names');
    expect(edgeList(names)).not.toContain(`${quote} -> ${record}`);

    const log = vi.fn<(message: string) => void>();
    await failOn('src/z.ts');
    const midway = await buildCallGraph({ ...input, log });
    expect(midway.mode).toBe('names');
    expect([...midway.edges]).toEqual([...names.edges]);
    expect([...midway.callsites]).toEqual([...names.callsites]);
    expect([...midway.callsites]).toEqual([[price, 3]]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('checker failed');
  });
});

describe('limit', () => {
  it('limit/400-files-falls-back-to-names: more than 400 touched TS files use names for the whole change, and it is logged', async () => {
    const count = MAX_TS_MORPH_FILES + 1;
    const files: GraphFile[] = [];
    for (let i = 0; i < count; i++) {
      const path = `src/m${String(i).padStart(3, '0')}.ts`;
      const next = i + 1 < count ? `m${String(i + 1).padStart(3, '0')}` : null;
      const source =
        (next === null ? '' : `import { f${String(i + 1)} } from './${next}';\n`) +
        `export function f${String(i)}(): number {\n  return ${next === null ? '0' : `f${String(i + 1)}()`};\n}\n`;
      const start = next === null ? 1 : 2;
      files.push({
        path,
        status: 'mod',
        after: source,
        symbols: [
          { id: id(path, `f${String(i)}`), name: `f${String(i)}`, kind: 'function', status: 'mod', range: { start, end: start + 2 } },
        ],
      });
    }
    const log = vi.fn<(message: string) => void>();
    const graph = await buildCallGraph({ files, log });
    expect(graph.mode).toBe('names');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(String(count));
    expect(graph.edges.get(id('src/m000.ts', 'f0'))?.map((edge) => edge.to)).toEqual([id('src/m001.ts', 'f1')]);

    const atLimit = await buildCallGraph({ files: files.slice(0, MAX_TS_MORPH_FILES), log });
    expect(atLimit.mode).toBe('ts-morph');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('graph determinism and filtering', () => {
  it('graph/deterministic: the order of the input files does not change the graph', async () => {
    const input = await fixtureChange('graph/ts-method-call-through-type');
    const a = await buildCallGraph(input);
    const b = await buildCallGraph({ ...input, files: [...input.files].reverse() });
    expect([...b.edges]).toEqual([...a.edges]);
    expect([...b.callsites]).toEqual([...a.callsites]);
  });

  it('graph/ignores: same, deleted and unreadable files and paths that leave the repo', async () => {
    const input = await fixtureChange('graph/ts-direct-call');
    const symbols = input.files[0]?.symbols ?? [];
    const noise: GraphFile[] = [
      { path: '../outside.ts', status: 'mod', after: 'export function x() {}\n', symbols },
      { path: 'src/gone.ts', status: 'del', after: null, symbols },
      { path: 'src/same.ts', status: 'same', after: 'export function y() {}\n', symbols },
      { path: 'db/schema.sql', status: 'mod', after: 'select 1;\n', symbols },
    ];
    const graph = await buildCallGraph({ ...input, files: [...input.files, ...noise] });
    expect(edgeList(graph)).toEqual([`${id('src/a.ts', 'run')} -> ${id('src/b.ts', 'helper')}`]);
  });
});

describe('readTsconfigPaths', () => {
  it('keeps single-star patterns inside the repo and drops the rest', async () => {
    const { ts } = await loadTsMorph();
    const text = JSON.stringify({
      extends: './elsewhere.json',
      compilerOptions: {
        paths: {
          '@a/*': ['src/a/*'],
          '@two/*/*': ['src/two/*'],
          '@up/*': ['../up/*', 'src/up/*'],
          '@abs/*': ['/etc/*'],
          '@dbl/*': ['src/*/*'],
        },
      },
    });
    expect(readTsconfigPaths(text, ts)).toEqual({ base: '', paths: { '@a/*': ['src/a/*'], '@up/*': ['src/up/*'] } });
    expect(readTsconfigPaths('{ "compilerOptions": {} }', ts)).toBeNull();
    expect(readTsconfigPaths('not json', ts)).toBeNull();
  });
});

describe('graph/in-memory-no-fs-access', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('graph/in-memory-no-fs-access: a hostile repo reads nothing from disk and reaches nothing outside', async () => {
    // A real outside directory next to a real repo directory, so the hostile specifiers do point at existing files.
    const work = mkdtempSync(join(tmpdir(), 'dc-graph-'));
    roots.push(work);
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(work, 'outside', 'secret.ts'), 'export function secret(): string { return "s"; }\n');
    write(join(work, 'outside', 'leak.ts'), 'export function leak(): string { return "l"; }\n');

    const input = await fixtureChange('graph/in-memory-no-fs-access');
    const afterDir = new URL('../fixtures/path/graph/in-memory-no-fs-access/after/', import.meta.url);
    for (const file of input.files) write(join(work, 'repo', file.path), readFileSync(new URL(file.path, afterDir), 'utf8'));
    const files: GraphFile[] = [
      ...input.files,
      {
        path: '../outside/secret.ts',
        status: 'mod',
        after: 'export function secret() {}\n',
        symbols: [{ id: id('../outside/secret.ts', 'secret'), name: 'secret', kind: 'function', status: 'mod', range: { start: 1, end: 1 } }],
      },
    ];

    const { ts } = await loadTsMorph();
    const spied: string[] = [];
    const sync = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync', 'openSync', 'accessSync', 'opendirSync'] as const;
    for (const method of sync) {
      const original = fs[method] as (...args: unknown[]) => unknown;
      vi.spyOn(fs, method as 'readFileSync').mockImplementation(((...args: unknown[]) => {
        spied.push(`${method}(${String(args[0])})`);
        return original(...args);
      }) as never);
    }
    for (const method of ['readFile', 'readdir', 'stat', 'lstat', 'realpath', 'open', 'access'] as const) {
      const original = fs.promises[method] as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, method as 'readFile').mockImplementation(((...args: unknown[]) => {
        spied.push(`promises.${method}(${String(args[0])})`);
        return original(...args);
      }) as never);
    }

    // Positive control: the spies see a read the TypeScript host makes, so an empty list below means something.
    const probe = join(work, 'outside', 'secret.ts');
    expect(ts.sys.readFile(probe)).toContain('secret');
    expect(spied.some((hit) => hit.includes(probe))).toBe(true);
    spied.length = 0;

    const graph = await buildCallGraph({ ...input, files });
    expect(graph.mode).toBe('ts-morph');
    // Only the in-repo import resolved; nothing outside was linked or read.
    expect(edgeList(graph)).toEqual([`${id('src/a.ts', 'run')} -> ${id('src/local.ts', 'local')}`]);
    expect(spied).toEqual([]);
  });
});

describe('graph/pinned-version', () => {
  it('graph/pinned-version: ts-morph is a dependency pinned to an exact version, as installed and locked', () => {
    interface Manifest {
      version?: string;
      dependencies?: Record<string, string>;
      packages?: Record<string, { version: string }>;
    }
    const read = (path: string): Manifest => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as Manifest;
    expect(read('package.json').dependencies?.['ts-morph']).toBe('28.0.0');
    expect(read('package-lock.json').packages?.['node_modules/ts-morph']?.version).toBe('28.0.0');
    expect(read('node_modules/ts-morph/package.json').version).toBe('28.0.0');
  });
});
