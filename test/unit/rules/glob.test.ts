import { describe, expect, it } from 'vitest';
import { globMatch, pathMatcher, scopeOf } from '../../../src/core/rules/index.js';

/**
 * The RegExp the include/exclude globs were built into before DC-126. Kept in
 * the test only, to show the linear matcher agrees with it on small inputs.
 */
function referenceGlob(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

describe('globMatch', () => {
  it.each([
    ['*', '', true],
    ['*', 'cart.ts', true],
    ['*', 'src/cart.ts', false],
    ['src/*.ts', 'src/cart.ts', true],
    ['src/*.ts', 'src/cart/total.ts', false],
    ['src/*/post.ts', 'src/ledger/post.ts', true],
    ['src/*/post.ts', 'src/ledger/deep/post.ts', false],
    ['src/**/*.ts', 'src/cart/total.ts', true],
    ['src/**/*.ts', 'src/total.ts', true],
    ['src/**/*.ts', 'src/a/b/c/total.ts', true],
    ['src/**/*.ts', 'lib/total.ts', false],
    ['**/*.test.ts', 'test/cart.test.ts', true],
    ['**/*.test.ts', 'cart.test.ts', true],
    ['**/*.test.ts', 'test/cart.ts', false],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'src/', true],
    ['src/**', 'src', false],
    ['**.ts', 'a/b/c.ts', true],
    ['a**b', 'a/x/b', true],
    ['a***b', 'a/x/b', true],
    ['x**/b', 'xb', true],
    ['x**/b', 'xx/b', true],
    ['x**/b', 'xxb', false],
    ['src/a.b*', 'src/aXb.ts', false],
    ['src/a.b*', 'src/a.b.ts', true],
    ['src/(x)+?*', 'src/(x)+?y', true],
    ['a*b*c', 'a-c-b', false],
    ['a*bc*bc', 'abcbc', true],
  ])('%s against %j: %s', (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
    expect(referenceGlob(pattern).test(path)).toBe(expected);
  });

  it('agrees with the former RegExp on every short pattern and path over a small alphabet', () => {
    const patternAlphabet = ['a', '/', '*'];
    const pathAlphabet = ['a', 'b', '/'];
    const all = (alphabet: string[], max: number): string[] => {
      const out = [''];
      for (let length = 1, layer = ['']; length <= max; length++) {
        layer = layer.flatMap((prefix) => alphabet.map((char) => prefix + char));
        out.push(...layer);
      }
      return out;
    };
    const paths = all(pathAlphabet, 5);
    for (const pattern of all(patternAlphabet, 5)) {
      const regexp = referenceGlob(pattern);
      for (const path of paths) {
        if (globMatch(pattern, path) !== regexp.test(path)) expect.fail(`${JSON.stringify(pattern)} against ${JSON.stringify(path)}`);
      }
    }
  });

  it('stays linear: a many-star pattern against a 10 KB path', () => {
    const segmentStars = `src/${'*a'.repeat(40)}*ab`;
    const crossingStars = `${'**a'.repeat(40)}**ab`;
    const mixed = `${'**/*a'.repeat(20)}*ab`;
    const path = `src/${'a'.repeat(10_240)}`;
    const deep = 'a/'.repeat(5_120);
    const started = performance.now();
    expect(pathMatcher(segmentStars)(path)).toBe(false);
    expect(pathMatcher(crossingStars)(path)).toBe(false);
    expect(pathMatcher(mixed)(deep)).toBe(false);
    expect(scopeOf([segmentStars], [crossingStars])(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
