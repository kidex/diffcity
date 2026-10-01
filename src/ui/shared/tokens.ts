// Reads the colour tokens from shared/tokens.css at run time, for drawing on a
// canvas or in three.js. TypeScript never holds a colour value of its own.

import type { Verdict } from '../../core/report/types.js';

export type AuditAge = 'fresh' | 'aging' | 'stale' | 'never';

/** The CSS custom property that holds a verdict colour. */
export function verdictToken(verdict: Verdict): `--verdict-${Verdict}` {
  return `--verdict-${verdict}`;
}

/** The CSS custom property that holds an audit-age colour. */
export function auditToken(age: AuditAge): `--audit-${AuditAge}` {
  return `--audit-${age}`;
}

/** The computed value of a custom property, e.g. `readToken('--add')`. */
export function readToken(name: `--${string}`, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(name).trim();
}
