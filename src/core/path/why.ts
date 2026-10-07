import type { Step, Symbol } from '../report/types.js';

// Step.why (ADR-034, SPEC.md 5.4 point 5): plain English from simple rules,
// first match wins. A finding with an explicit `why` hint replaces the rule
// text when findings are overlaid on the report (applyWhyOverrides).

export interface WhyContext {
  symbol: Pick<Symbol, 'kind' | 'name' | 'status'>;
  /** Set when the symbol is a route entry point. */
  route?: { method: string; path: string; isNew: boolean } | undefined;
  /** Call sites of a `sig` symbol (the call graph's count). */
  callsites?: number | undefined;
  /** The symbol is a test (a test file, or a `describe` / `it` / `test` block). */
  test: boolean;
}

const KIND_WORDS: Readonly<Record<Symbol['kind'], string>> = {
  class: 'class',
  function: 'function',
  method: 'method',
  export: 'export',
  sql: 'SQL statement',
};

export function whyFor(context: WhyContext): string {
  const { symbol, route } = context;
  if (route !== undefined) {
    return route.isNew ? `New endpoint ${route.method} ${route.path}` : `Endpoint changed: ${route.method} ${route.path}`;
  }
  if (symbol.status === 'sig') {
    const n = context.callsites ?? 0;
    return n > 0 ? `Signature changed, ${String(n)} call ${n === 1 ? 'site' : 'sites'} rewritten` : 'Signature changed';
  }
  if (symbol.kind === 'sql' && (symbol.status === 'add' || symbol.status === 'mod')) return `Schema modified: ${symbol.name}`;
  if (symbol.status === 'add' && context.test) return 'New test';
  if (symbol.status === 'add') return `New ${KIND_WORDS[symbol.kind]}`;
  if (symbol.status === 'del') return `Removed ${KIND_WORDS[symbol.kind]}`;
  return 'Body changed';
}

/**
 * The steps with `why` replaced for every symbol id in `overrides` (a finding
 * imported with an explicit `why` hint on that symbol, ADR-036). Pure: the
 * input steps are not changed; steps without an override are returned as is.
 */
export function applyWhyOverrides(steps: readonly Step[], overrides: ReadonlyMap<string, string>): Step[] {
  return steps.map((step) => {
    const why = overrides.get(step.symbolId);
    return why === undefined ? step : { ...step, why };
  });
}
