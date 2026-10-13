// The layers rule's pure parts (ADR-031): resolution candidates, module
// matching and overlap, and the before file list. Invented paths.

import { describe, expect, it } from 'vitest';
import { beforeFilesOf, createResolver, layerModules, moduleOf, wildcardMatch, type LayerModule } from '../../../src/core/rules/index.js';

function modules(layers: string[][]): LayerModule[] {
  const parsed = layerModules(layers);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.modules;
}

describe('layers resolution', () => {
  it('tries the exact path, the extensions in order, the TS sibling, then index files', () => {
    const resolve = (files: string[], specifier: string): string | null => {
      const result = createResolver(new Set(files))('src/core/a.ts', specifier);
      return result.kind === 'file' ? result.path : result.kind;
    };
    expect(resolve(['src/core/b', 'src/core/b.ts'], './b')).toBe('src/core/b');
    expect(resolve(['src/core/b.d.ts', 'src/core/b.ts'], './b')).toBe('src/core/b.ts');
    expect(resolve(['src/core/b.d.ts'], './b')).toBe('src/core/b.d.ts');
    expect(resolve(['src/core/b.tsx'], './b.js')).toBe('src/core/b.tsx');
    expect(resolve(['src/core/b.cts'], './b.cjs')).toBe('src/core/b.cts');
    expect(resolve(['src/core/b.ts', 'src/core/b/index.ts'], './b')).toBe('src/core/b.ts');
    expect(resolve(['src/core/b/index.js'], './b')).toBe('src/core/b/index.js');
    expect(resolve(['src/x.ts'], '..')).toBe('unresolved');
    expect(resolve(['src/core/index.ts'], '.')).toBe('src/core/index.ts');
    expect(resolve([], './nowhere')).toBe('unresolved');
    expect(resolve([], '/etc/thing')).toBe('unresolved');
    expect(resolve([], 'left-pad')).toBe('external');
  });

  it('tsconfig paths: an exact pattern first, then the longest prefix, targets in order, under baseUrl', () => {
    const files = new Set(['web/lib/date.ts', 'web/shared/date.ts', 'web/env.ts']);
    const resolve = createResolver(files, {
      tsconfigPaths: { base: 'web', paths: { '@/*': ['missing/*', 'shared/*'], '@/lib/*': ['lib/*'], '@env': ['env.ts'] } },
    });
    expect(resolve('web/app.ts', '@/lib/date')).toEqual({ kind: 'file', path: 'web/lib/date.ts' });
    expect(resolve('web/app.ts', '@/date')).toEqual({ kind: 'file', path: 'web/shared/date.ts' });
    expect(resolve('web/app.ts', '@env')).toEqual({ kind: 'file', path: 'web/env.ts' });
    expect(resolve('web/app.ts', '@/none')).toEqual({ kind: 'unresolved' });
  });
});

describe('layers modules', () => {
  it('matches whole path segments, longest match first', () => {
    const list = modules([['src/cli'], ['src'], ['packages/*/src']]);
    expect(moduleOf(list, 'src/cli/run.ts')).toEqual({ module: 'src/cli', layer: 0 });
    expect(moduleOf(list, 'src/client/run.ts')).toEqual({ module: 'src', layer: 1 });
    expect(moduleOf(list, 'packages/pay-core/src/a.ts')).toEqual({ module: 'packages/pay-core/src', layer: 2 });
    expect(moduleOf(list, 'packages/pay-core/test/a.ts')).toBeNull();
    expect(moduleOf(list, 'README.md')).toBeNull();
  });

  it.each([
    [['packages/pay-*'], ['packages/*-core'], false],
    [['packages/a*'], ['packages/b*'], true],
    [['packages/*x'], ['packages/*y'], true],
    [['packages/*'], ['packages/billing'], false],
    [['packages/billing'], ['packages/*/src'], true],
  ])('%j and %j: valid %s', (top, bottom, valid) => {
    expect(layerModules([top, bottom]).ok).toBe(valid);
  });
});

describe('wildcardMatch', () => {
  it.each([
    ['*', '', true],
    ['*', 'billing', true],
    ['pay-*', 'pay-', true],
    ['pay-*', 'pay-core', true],
    ['pay-*', 'pa', false],
    ['*-core', 'pay-core', true],
    ['*-core', 'pay-cor', false],
    ['a*b', 'ab', true],
    ['a*b', 'axxb', true],
    ['a*b', 'axxbc', false],
    ['a**b', 'ab', true],
    ['a***b', 'a-b', true],
    ['**', 'anything', true],
    ['a*b*c', 'abc', true],
    ['a*b*c', 'a-c-b', false],
    ['a*bc*bc', 'abcbc', true],
    ['ab*ba', 'aba', false],
    ['a*x*a', 'axa', true],
    ['a*x*a', 'axxa', true],
    ['a*xx*a', 'axa', false],
    ['*a*', 'bab', true],
    ['billing', 'billing', true],
    ['billing', 'billings', false],
    ['*', 'a/b', false],
  ])('%s against %j: %s', (pattern, value, expected) => {
    expect(wildcardMatch(pattern, value)).toBe(expected);
  });

  it('stays linear: a many-star segment against a 10 KB name', () => {
    const pattern = `${'*a'.repeat(40)}*ab`;
    const name = 'a'.repeat(10_240);
    const started = performance.now();
    expect(wildcardMatch(pattern, name)).toBe(false);
    expect(moduleOf(modules([[`pkgs/${pattern}`]]), `pkgs/${name}/x.ts`)).toBeNull();
    // An entry at the 1,024-character cap (ADR-030), the longest overlap check validation can ask for.
    expect(layerModules([[`pkgs/${pattern}`], [`pkgs/${name.slice(0, 1019)}`]]).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('beforeFilesOf', () => {
  it('undoes adds and renames and brings deleted files back', () => {
    expect(
      beforeFilesOf(
        ['src/a.ts', 'src/new.ts', 'src/moved.ts'],
        [
          { path: 'src/new.ts', oldPath: null, type: 'add' },
          { path: 'src/moved.ts', oldPath: 'src/old.ts', type: 'rename' },
          { path: 'src/gone.ts', oldPath: 'src/gone.ts', type: 'del' },
          { path: 'src/a.ts', oldPath: 'src/a.ts', type: 'mod' },
        ],
      ),
    ).toEqual(['src/a.ts', 'src/gone.ts', 'src/old.ts']);
  });
});
