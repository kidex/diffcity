// Scene colours from the CSS tokens on :root (src/ui/shared/tokens.css): the
// mockup palette plus the --c-* night-city tokens (ADR-026). TypeScript never
// holds a colour value; three.js converts the sRGB token to linear.

import { Color } from 'three';

import type { Status, Verdict } from '../../../../core/report/types.js';
import { readToken, verdictToken } from '../../../shared/tokens.js';

export type Token = `--${string}`;

/** A colour token as a three.js colour; throws on a missing token, so a typo never renders black. */
export function colorToken(name: Token): Color {
  const value = readToken(name);
  if (value === '') throw new Error(`Missing CSS token ${name}`);
  return new Color(value);
}

/** A numeric token (e.g. the bloom strength), or `fallback` when missing. */
export function numberToken(name: Token, fallback: number): number {
  const value = Number.parseFloat(readToken(name));
  return Number.isFinite(value) ? value : fallback;
}

/** The floor colour of a status: untouched floors use the mockup's --same-top. */
export function statusToken(status: Status): Token {
  return status === 'same' ? '--same-top' : `--${status}`;
}

export function verdictColor(verdict: Verdict): Color {
  return colorToken(verdictToken(verdict));
}
