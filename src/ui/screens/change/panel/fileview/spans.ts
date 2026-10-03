// Symbol spans of the full diff (ADR-027 `symbols`): which symbol a row belongs
// to, for the hover sync with the city's floors. Pure.

import type { Span } from './layout.js';

export interface SymbolSpan extends Span {
  id: string;
}

/** Spans that fit the rows, in the daemon's order; a span may contain another (a method in its class). */
export function cleanSymbols(symbols: readonly SymbolSpan[] | undefined, rowCount: number): SymbolSpan[] {
  return (symbols ?? []).filter(
    (span) => Number.isInteger(span.first) && Number.isInteger(span.last) && span.first >= 0 && span.last >= span.first && span.last < rowCount,
  );
}

/** The innermost span of each row (index into `spans`), -1 for none. */
export function owners(spans: readonly SymbolSpan[], rowCount: number): Int32Array {
  const owner = new Int32Array(rowCount).fill(-1);
  // Widest first, so the narrower ones written later win.
  const order = spans.map((span, index) => ({ span, index })).sort((a, b) => b.span.last - b.span.first - (a.span.last - a.span.first));
  for (const { span, index } of order) owner.fill(index, span.first, span.last + 1);
  return owner;
}

/** The span of `symbolId`, if the diff has one. */
export const spanOf = (spans: readonly SymbolSpan[], symbolId: string | null): SymbolSpan | null =>
  symbolId === null ? null : (spans.find((span) => span.id === symbolId) ?? null);
