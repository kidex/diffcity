// a11y/label-contrast-aa (DC-89): the text of the change screen meets WCAG AA
// (4.5:1) against the grounds it sits on, in the night theme and in both light
// blocks. The ratios are computed from the values in src/ui/shared/tokens.css:
// label, tag and muted text, and the ten highlight classes on --code-bg.

/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];
type Tokens = Map<string, string>;

const css = readFileSync(new URL('../../../src/ui/shared/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the block that starts with `selector {`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

function declarations(body: string, into: Tokens): Tokens {
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into.set(match[1] ?? '', (match[2] ?? '').trim());
  return into;
}

const dark = declarations(block(':root'), new Map());
const lightMedia = declarations(block(':root:not([data-theme="dark"])'), new Map(dark));
const lightAttribute = declarations(block(':root[data-theme="light"]'), new Map(dark));

function parse(value: string, tokens: Tokens): { rgb: Rgb; alpha: number } {
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref !== null) return parse(tokens.get(ref[1] ?? '') ?? '', tokens);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex !== null) {
    const n = parseInt(hex[1] ?? '', 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba !== null) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  throw new Error(`cannot read the colour "${value}"`);
}

const over = (top: Rgb, alpha: number, ground: Rgb): Rgb => [0, 1, 2].map((i) => (top[i] ?? 0) * alpha + (ground[i] ?? 0) * (1 - alpha)) as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two opaque colours. */
export function ratio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA = 4.5;

const THEMES: { name: string; tokens: Tokens }[] = [
  { name: 'night (dark)', tokens: dark },
  { name: 'light (prefers-color-scheme)', tokens: lightMedia },
  { name: 'light (data-theme)', tokens: lightAttribute },
];

const colour = (tokens: Tokens, name: string): Rgb => parse(`var(${name})`, tokens).rgb;

/** Every failing pair, as a readable line; the tests expect none. */
function failures(tokens: Tokens, texts: string[], grounds: string[], tint = 0): string[] {
  const failed: string[] = [];
  for (const text of texts) {
    for (const ground of grounds) {
      const fg = colour(tokens, text);
      // A tag's ground is a tint of its own colour over the surface it sits on.
      const bg = tint === 0 ? colour(tokens, ground) : over(colour(tokens, text === '--spec-text' ? '--verdict-spec' : text.replace(/-text$/, '')), tint, colour(tokens, ground));
      const value = ratio(fg, bg);
      if (value < AA) failed.push(`${text} on ${ground}${tint === 0 ? '' : ` (tinted ${String(tint)})`}: ${value.toFixed(2)}`);
    }
  }
  return failed;
}

const SURFACES = ['--bg', '--bg-deep', '--panel', '--panel-2', '--c-void', '--c-ground'];
const TAG_SURFACES = ['--bg', '--bg-deep', '--panel', '--c-ground'];
const TAG_TEXT = ['--add-text', '--mod-text', '--sig-text', '--del-text', '--tier-text', '--spec-text'];
const CODE = ['kw', 'str', 'num', 'com', 'type', 'fn', 'prop', 'op', 'punc', 'var'].map((name) => `--code-${name}`);

describe('a11y/label-contrast-aa', () => {
  it('the two light blocks of tokens.css are the same colours', () => {
    expect(Object.fromEntries(lightMedia)).toEqual(Object.fromEntries(lightAttribute));
  });

  for (const { name, tokens } of THEMES) {
    describe(name, () => {
      it('ink, secondary ink and --muted read on every surface', () => {
        expect(failures(tokens, ['--ink', '--ink-2', '--muted'], SURFACES)).toEqual([]);
      });

      it('tag and counter text reads on the tint of its own colour', () => {
        expect(failures(tokens, TAG_TEXT, TAG_SURFACES, 0.16)).toEqual([]);
        expect(failures(tokens, TAG_TEXT, TAG_SURFACES)).toEqual([]);
      });

      it('the "same" verdict tag, written in secondary ink, reads on its tint', () => {
        const surfaces = TAG_SURFACES.map((ground) => over(colour(tokens, '--verdict-same'), 0.13, colour(tokens, ground)));
        for (const ground of surfaces) expect(ratio(colour(tokens, '--ink-2'), ground)).toBeGreaterThanOrEqual(AA);
      });

      it('the highlight classes read on --code-bg, and on the added and removed rows', () => {
        const base = colour(tokens, '--code-bg');
        const rows = [base, ...['--code-add', '--code-del'].map((row) => {
          const { rgb, alpha } = parse(tokens.get(row) ?? '', tokens);
          return over(rgb, alpha, base);
        })];
        const failed: string[] = [];
        for (const code of CODE) {
          for (const row of rows) {
            const value = ratio(colour(tokens, code), row);
            if (value < AA) failed.push(`${code}: ${value.toFixed(2)}`);
          }
        }
        expect(failed).toEqual([]);
      });
    });
  }

  it('the roof badges of the city read on the night ground and on the pale one', () => {
    const failed: string[] = [];
    for (const verdict of ['eyes', 'risky', 'spec', 'ok', 'same']) {
      const token = `--verdict-${verdict}`;
      for (const { name, tokens } of THEMES) {
        const light = name !== 'night (dark)';
        const c = colour(tokens, token);
        // change.css: the badge text is the verdict colour mixed 80 % toward white at night (the "same" badge is secondary ink), and 40 % of it over --ink on the pale ground.
        const text = light ? over(c, 0.4, colour(tokens, '--ink')) : verdict === 'same' ? colour(tokens, '--ink-2') : over(c, 0.8, [255, 255, 255]);
        // Its ground: the scene's ground under a 26 % tint of the verdict colour.
        const ground = over(c, 0.26, colour(tokens, '--c-ground'));
        const value = ratio(text, ground);
        if (value < AA) failed.push(`${verdict} badge, ${name}: ${value.toFixed(2)}`);
      }
    }
    expect(failed).toEqual([]);
  });
});
