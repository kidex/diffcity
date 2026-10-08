// The layers rule (ADR-031) over the invented `orchard` trees of
// test/fixtures/rules/layers/: layers [src/cli, src/ui] (0, top), [src/daemon]
// (1), [src/core] (2, bottom), unless a case says otherwise.

import { describe, expect, it } from 'vitest';
import type { RuleCheck } from '../../../src/core/report/types.js';
import { mergeRules, ruleFindingId, runRules, type RuleFile } from '../../../src/core/rules/index.js';
import { CASE_TIME, findingRows, runLayersCase } from '../../helpers/layers-case.js';

const UPWARD_DAEMON = 'Upward import: src/core → src/daemon';

function check(state: RuleCheck['state'], findings: number, reason?: string): RuleCheck {
  return { ruleId: 'layers', kind: 'layers', state, ...(reason === undefined ? {} : { reason }), findings, checkedAt: CASE_TIME };
}

describe('layers: direction', () => {
  it('layers/downward-allowed: an import to a lower layer passes', async () => {
    const run = await runLayersCase('downward-allowed');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0)]);
  });

  it('layers/same-module-allowed: imports inside a module pass, nested directories included', async () => {
    const run = await runLayersCase('same-module-allowed');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0)]);
  });

  it('layers/horizontal-violation: two modules of the same layer', async () => {
    const run = await runLayersCase('horizontal-violation');
    expect(findingRows(run.findings)).toEqual([['src/cli/run.ts', 1, 'Horizontal import: src/cli → src/ui']]);
    expect(run.findings[0]?.message).toBe("Import '../ui/panel.js' goes from src/cli (layer 0) to src/ui (layer 0). Allowed: imports to a lower layer.");
    expect(run.checks).toEqual([check('violations', 1)]);
  });

  it('layers/upward-violation: one file-level finding on the statement line, med architecture by default', async () => {
    const run = await runLayersCase('upward-violation');
    expect(run.findings).toEqual([
      {
        id: ruleFindingId('layers', 'src/core/ledger.ts', 1, UPWARD_DAEMON),
        source: 'rule:layers',
        severity: 'med',
        category: 'architecture',
        file: 'src/core/ledger.ts',
        line: 1,
        title: UPWARD_DAEMON,
        message: "Import '../daemon/server' goes from src/core (layer 2) to src/daemon (layer 1). Allowed: imports to a lower layer.",
        state: 'open',
      },
    ]);
    expect((await runLayersCase('upward-violation', { severity: 'high' })).findings[0]?.severity).toBe('high');
  });
});

describe('layers: new edges only', () => {
  it('layers/only-new-edges: an import-only change reports the module pair the file did not import before', async () => {
    const run = await runLayersCase('only-new-edges');
    // ADR-008: an import-only change gives the file its git status.
    expect(run.files.map((file) => [file.path, file.status])).toEqual([['src/core/ledger.ts', 'mod']]);
    // The queue import reaches src/daemon, which the file already imported: not a new edge.
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 3, 'Upward import: src/core → src/cli']]);
  });

  it('layers/existing-edge-not-reported: a violating edge the before version had is not reported', async () => {
    const run = await runLayersCase('existing-edge-not-reported');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0)]);
  });

  it('layers/report-existing-opt-in: reportExisting reports every violating edge of a touched file', async () => {
    const run = await runLayersCase('report-existing-opt-in');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('layers/renamed-file-compares-old-path: a renamed file is compared with its old path', async () => {
    const run = await runLayersCase('renamed-file-compares-old-path');
    expect(run.files.map((file) => [file.path, file.oldPath])).toEqual([['src/core/books/ledger.ts', 'src/core/ledger.ts']]);
    // The daemon edge existed under the old path (with another relative specifier); the ui edge is new.
    expect(findingRows(run.findings)).toEqual([['src/core/books/ledger.ts', 2, 'Upward import: src/core → src/ui']]);
  });
});

describe('layers: statements', () => {
  it('layers/type-only-counts-by-default: a type-only import is still a dependency', async () => {
    const run = await runLayersCase('type-only-counts-by-default');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('layers/type-only-allowed-opt-in: allowTypeImports skips import type, export type, and all-type named imports and re-exports', async () => {
    expect((await runLayersCase('type-only-allowed-opt-in')).checks).toEqual([check('passed', 0)]);
    const counted = await runLayersCase('type-only-allowed-opt-in', { allowTypeImports: false });
    expect(findingRows(counted.findings)).toEqual([
      ['src/core/ledger.ts', 1, UPWARD_DAEMON],
      ['src/core/ledger.ts', 2, UPWARD_DAEMON],
      ['src/core/ledger.ts', 3, UPWARD_DAEMON],
      ['src/core/ledger.ts', 4, UPWARD_DAEMON],
    ]);
  });

  it('layers/mixed-type-specifiers-not-type-only: a value next to a type keeps the import a dependency', async () => {
    const run = await runLayersCase('mixed-type-specifiers-not-type-only');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('layers/export-from-counts: a re-export is an import', async () => {
    const run = await runLayersCase('export-from-counts');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('layers/require-literal: require with a string literal is an import', async () => {
    const run = await runLayersCase('require-literal');
    expect(findingRows(run.findings)).toEqual([['src/core/legacy.cjs', 1, UPWARD_DAEMON]]);
  });

  it('layers/dynamic-import-anchors-to-function: a dynamic import inside a function anchors to its floor', async () => {
    const run = await runLayersCase('dynamic-import-anchors-to-function');
    const loader = run.files[0]?.symbols.find((symbol) => symbol.name === 'loadServer');
    expect(loader?.range).toEqual({ start: 5, end: 8 });
    expect(run.findings.map((finding) => [finding.line, finding.title, finding.symbolId])).toEqual([[6, UPWARD_DAEMON, loader?.id]]);
  });

  it('layers/template-specifier-unresolved: a template specifier is never passing evidence', async () => {
    const run = await runLayersCase('template-specifier-unresolved');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0, '1 import could not be resolved')]);
  });
});

describe('layers: resolution', () => {
  it('layers/js-to-ts-sibling: a .js or .mjs specifier resolves to its TS sibling', async () => {
    const run = await runLayersCase('js-to-ts-sibling');
    expect(findingRows(run.findings)).toEqual([
      ['src/core/ledger.ts', 1, UPWARD_DAEMON],
      ['src/core/ledger.ts', 2, UPWARD_DAEMON],
    ]);
    expect(run.checks[0]?.reason).toBeUndefined();
  });

  it('layers/index-resolution: a directory specifier resolves to its index file', async () => {
    const run = await runLayersCase('index-resolution');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
  });

  it('layers/alias-prefix: the longest alias prefix wins; packages are ignored; an alias to nothing is unresolved', async () => {
    const run = await runLayersCase('alias-prefix');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 3, UPWARD_DAEMON]]);
    expect(run.checks).toEqual([check('violations', 1, '1 import could not be resolved')]);
  });

  it('layers/tsconfig-paths-star: compilerOptions.paths from tsconfig.json as JSONC data, extends not followed', async () => {
    const run = await runLayersCase('tsconfig-paths-star');
    // `#ui/*` is only in the extended file: a package as far as the rule knows.
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
    expect(run.checks).toEqual([check('violations', 1)]);
    expect((await runLayersCase('tsconfig-paths-star', { useTsconfigPaths: false })).checks).toEqual([check('passed', 0)]);
  });

  it('layers/escape-root-unresolved: a relative specifier that leaves the repo is unresolved', async () => {
    const run = await runLayersCase('escape-root-unresolved');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0, '1 import could not be resolved')]);
  });
});

describe('layers: modules', () => {
  it('layers/file-outside-modules-ignored: imports from and to a file in no module are ignored, unresolved ones too', async () => {
    const run = await runLayersCase('file-outside-modules-ignored');
    expect(run.findings).toEqual([]);
    expect(run.checks).toEqual([check('passed', 0)]);
  });

  it('layers/glob-module-per-package: each glob match is its own module', async () => {
    const run = await runLayersCase('glob-module-per-package');
    expect(findingRows(run.findings)).toEqual([['packages/billing/src/invoice.ts', 2, 'Horizontal import: packages/billing/src → packages/catalog/src']]);
  });

  it('layers/config-overlap-error: overlapping globs, a module listed twice and an empty layer are config errors', async () => {
    const run = await runLayersCase('config-overlap-error');
    expect(run.findings).toEqual([]);
    const prefix = 'config-error: settings.json rules: rule "layers": field "layers": ';
    expect(run.checks).toEqual([check('error', 0, `${prefix}modules "packages/*/src" and "packages/billing/src" overlap and are not nested`)]);
    const twice = await runLayersCase('config-overlap-error', { layers: [['packages/billing/src'], ['packages/billing/src/']] });
    expect(twice.checks).toEqual([check('error', 0, `${prefix}module "packages/billing/src" is listed twice`)]);
    const empty = await runLayersCase('config-overlap-error', { layers: [['packages/billing/src'], []] });
    expect(empty.checks[0]?.state).toBe('error');
    // Nested entries are not an overlap: the longest prefix wins.
    const nested = await runLayersCase('config-overlap-error', { layers: [['packages/catalog'], ['packages/*/src']] });
    expect(findingRows(nested.findings)).toEqual([['packages/catalog/src/item.ts', 1, 'Horizontal import: packages/catalog/src → packages/billing/src']]);
  });

  it.each([
    ['an absolute path', '/src/core'],
    ['a parent segment', 'src/../core'],
    ['a double star', 'packages/**/src'],
    ['an empty segment', 'src//core'],
  ])('rejects a module with %s', async (_name, module) => {
    const run = await runLayersCase('upward-violation', { layers: [[module], ['src/daemon']] });
    expect(run.checks[0]?.state).toBe('error');
    expect(run.checks[0]?.reason).toMatch(/^config-error: .*field "layers": module /);
  });
});

describe('layers: check', () => {
  it('layers/check-reason-counts-unresolved: the reason counts unresolved imports of checked files, next to the violations', async () => {
    const run = await runLayersCase('check-reason-counts-unresolved');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
    // ./gone.js, @lost/thing and require(name); scripts/seed.ts is in no module.
    expect(run.checks).toEqual([check('violations', 1, '3 imports could not be resolved')]);
  });
});

describe('layers: missing evidence is in the reason', () => {
  const LAYERS = [['src/cli', 'src/ui'], ['src/daemon'], ['src/core']];

  function file(path: string, imports: RuleFile['imports'], status: RuleFile['status'] = 'mod'): RuleFile {
    return { path, status, symbols: [], after: null, ...(imports === undefined ? {} : { imports }) };
  }

  it('layers/unparsed-file-noted: a checked code file that was not parsed is counted; the state follows the edges found', () => {
    const unparsed = { before: null, after: null };
    const files = [
      file('src/core/post.ts', { before: [], after: [{ specifier: '../daemon/server.js', line: 1, typeOnly: false }, { specifier: './gone.js', line: 2, typeOnly: false }] }),
      // Over 2 MB or binary: no imports for either version.
      file('src/core/huge.ts', unparsed),
      file('src/daemon/blob.js', unparsed, 'add'),
      // Not counted: not code, outside every module, deleted, untouched.
      file('src/core/logo.png', unparsed),
      file('src/core/schema.sql', unparsed),
      file('scripts/huge.ts', unparsed),
      file('src/core/gone.ts', unparsed, 'del'),
      file('src/core/same.ts', unparsed, 'same'),
    ];
    const context = { afterFiles: new Set(['src/core/post.ts', 'src/daemon/server.ts']), beforeFiles: new Set<string>(), tsconfigPaths: null };
    const run = (layers: unknown, extra: Record<string, unknown> = {}): RuleCheck | undefined =>
      runRules(mergeRules({ settings: [{ id: 'layers', kind: 'layers', layers, ...extra }] }), files, CASE_TIME, context).checks[0];
    expect(run(LAYERS)).toEqual(check('violations', 1, '1 import could not be resolved; 2 files could not be parsed'));
    expect(run([['src/core'], ['src/daemon']])).toEqual(check('passed', 0, '1 import could not be resolved; 2 files could not be parsed'));
    const missing = { ...context, tsconfigProblem: 'not found' as const };
    const withTsconfig = runRules(mergeRules({ settings: [{ id: 'layers', kind: 'layers', layers: LAYERS, useTsconfigPaths: true }] }), files.slice(1, 2), CASE_TIME, missing);
    expect(withTsconfig.checks).toEqual([check('passed', 0, '1 file could not be parsed; tsconfig.json not found')]);
  });

  it('layers/tsconfig-missing-noted: useTsconfigPaths without a root tsconfig.json says so', async () => {
    const run = await runLayersCase('upward-violation', { useTsconfigPaths: true });
    expect(run.checks).toEqual([check('violations', 1, 'tsconfig.json not found')]);
    // Without useTsconfigPaths the file is not needed.
    expect((await runLayersCase('upward-violation')).checks).toEqual([check('violations', 1)]);
  });

  it('layers/tsconfig-unparsable-noted: a tsconfig.json that cannot be parsed says so, and maps nothing', async () => {
    const run = await runLayersCase('tsconfig-unparsable-noted');
    expect(findingRows(run.findings)).toEqual([['src/core/ledger.ts', 1, UPWARD_DAEMON]]);
    expect(run.checks).toEqual([check('violations', 1, 'tsconfig.json could not be parsed')]);
  });
});
