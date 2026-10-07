// Edge cases of the call graph (ADR-034) beyond the required fixtures:
// tagged templates, JSX through a namespace, deleted callees and files, and
// order independence in names mode.

import { describe, expect, it } from 'vitest';
import { buildCallGraph, type CallGraph } from '../../src/core/path/graph.js';
import { fixtureChange, id } from '../helpers/path-fixture.js';

function edgeList(graph: CallGraph): string[] {
  return [...graph.edges].flatMap(([from, list]) => list.map((edge) => `${from} -> ${edge.to}`));
}

describe('graph edge cases', () => {
  it('graph/ts-tagged-template: a tagged template is an edge to the tag function', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-tagged-template'));
    expect(graph.mode).toBe('ts-morph');
    expect(edgeList(graph)).toEqual([`${id('src/query.ts', 'findOrder')} -> ${id('src/tag.ts', 'sql')}`]);
  });

  it('graph/ts-jsx-namespace: <Ns.Component /> in a TSX file resolves to the component in another file', async () => {
    const graph = await buildCallGraph(await fixtureChange('graph/ts-jsx-namespace'));
    expect(graph.mode).toBe('ts-morph');
    expect(edgeList(graph)).toEqual([`${id('src/shelf.tsx', 'Shelf')} -> ${id('src/widgets.tsx', 'Badge')}`]);
  });

  it('graph/js-deleted-callee-no-edge: a call to a deleted symbol makes no edge, the surviving callee does', async () => {
    const input = await fixtureChange('graph/js-deleted-callee-no-edge');
    const stock = input.files.find((file) => file.path === 'src/stock.js');
    expect(stock?.symbols.find((symbol) => symbol.name === 'restock')?.status).toBe('del');
    // The file survives with `kept`; its status is `del` only because `del` outweighs `mod` (SPEC.md 5).
    expect(stock?.status).toBe('del');
    const graph = await buildCallGraph(input);
    expect(graph.mode).toBe('names');
    expect(edgeList(graph)).toEqual([`${id('src/shop.js', 'open')} -> ${id('src/stock.js', 'kept')}`]);
  });

  it('graph/ts-symbol-removed-file-kept: a file whose status is del because it lost a symbol still has its other symbols in the graph', async () => {
    const input = await fixtureChange('graph/ts-symbol-removed-file-kept');
    const rates = input.files.find((file) => file.path === 'src/rates.ts');
    // SPEC.md 5: the file status is the heaviest symbol status, so a surviving file that lost a symbol is `del`.
    expect(rates?.status).toBe('del');
    expect(rates?.after).not.toBeNull();
    const graph = await buildCallGraph(input);
    expect(edgeList(graph)).toEqual([`${id('src/invoice.ts', 'total')} -> ${id('src/rates.ts', 'rate')}`]);
  });

  it('graph/ts-deleted-file-no-edge: a deleted file is not in the project and gives no edge', async () => {
    const input = await fixtureChange('graph/ts-deleted-file-no-edge');
    expect(input.files.find((file) => file.path === 'src/legacy.ts')?.status).toBe('del');
    const graph = await buildCallGraph(input);
    expect(graph.mode).toBe('ts-morph');
    expect(edgeList(graph)).toEqual([]);
  });

  it('graph/deterministic (names): reversed input gives the same JS graph and call sites', async () => {
    const input = await fixtureChange('graph/js-name-match');
    const a = await buildCallGraph(input);
    const b = await buildCallGraph({ ...input, files: [...input.files].reverse() });
    expect(edgeList(a).length).toBeGreaterThan(0);
    expect([...b.edges]).toEqual([...a.edges]);
    expect([...b.callsites]).toEqual([...a.callsites]);
  });

  it('graph/deterministic (jsx): reversed input gives the same TSX graph', async () => {
    const input = await fixtureChange('graph/ts-jsx-element');
    const a = await buildCallGraph(input);
    const b = await buildCallGraph({ ...input, files: [...input.files].reverse() });
    expect([...b.edges]).toEqual([...a.edges]);
  });
});
