// Every colour comes from a CSS custom property: the app's tokens
// (src/ui/shared/tokens.css, from the mockup palette) plus a few
// direction-specific ones declared in each direction's style.css. TypeScript
// never holds a colour value of its own.

import { Color } from 'three';
import type { Status, Verdict } from '../../../src/core/report/types.js';

export type Token = `--${string}`;

/** The computed value of a custom property on :root. */
export function cssToken(name: Token): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value === '') throw new Error(`Missing CSS token ${name}`);
  return value;
}

/** A token as a three.js colour (sRGB in, linear working space). */
export function colorToken(name: Token): Color {
  return new Color(cssToken(name));
}

export function statusToken(status: Status): Token {
  return status === 'same' ? '--same-top' : `--${status}`;
}

export function verdictToken(verdict: Verdict): Token {
  return `--verdict-${verdict}`;
}

export function severityToken(severity: 'high' | 'med' | 'low'): Token {
  return `--sev-${severity}`;
}
