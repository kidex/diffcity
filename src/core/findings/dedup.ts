import type { Finding } from '../report/types.js';
import { normalizeTitle } from './normalize.js';
import type { FindingState, StoredFinding } from './types.js';

const SEVERITY_RANK: Record<Finding['severity'], number> = { low: 0, med: 1, high: 2 };

/**
 * The state of a merged entry (PO decision 2026-10-07): any `intended` part
 * gives `intended`; otherwise any `open` part gives `open`; `fixed` only when
 * every part is fixed. A fixed part from one source never hides an open one.
 */
function mergeState(a: FindingState, b: FindingState): FindingState {
  if (a === 'intended' || b === 'intended') return 'intended';
  if (a === 'open' || b === 'open') return 'open';
  return 'fixed';
}

/** What makes two findings the same one: symbol (or file at file level), category, normalized title. */
export function dedupIdentity(finding: Pick<Finding, 'symbolId' | 'file' | 'category' | 'title'>): string {
  const target = finding.symbolId === undefined ? `file:${finding.file}` : `symbol:${finding.symbolId}`;
  return `${target}\0${finding.category}\0${normalizeTitle(finding.title)}`;
}

/**
 * Merges findings with the same identity (SPEC.md 5.6, ADR-036). The first in
 * input order keeps its key, `source`, message and anchor; `sources` lists
 * every source in order; the highest severity and the first non-empty `fix`
 * win; the state is `intended` if any part is, else `open` if any part is,
 * else `fixed`.
 *
 * The result depends on input order, so the store must return findings in
 * import order (the order they were first imported) for a deterministic merge.
 */
export function dedup(stored: readonly StoredFinding[]): StoredFinding[] {
  const merged = new Map<string, StoredFinding>();
  for (const entry of stored) {
    const identity = dedupIdentity(entry.finding);
    const first = merged.get(identity);
    if (first === undefined) {
      merged.set(identity, {
        ...entry,
        finding: { ...entry.finding, sources: [...new Set([entry.finding.source, ...(entry.finding.sources ?? [])])] },
      });
      continue;
    }
    const a = first.finding;
    const b = entry.finding;
    const fix = a.fix !== undefined && a.fix !== '' ? a.fix : b.fix !== undefined && b.fix !== '' ? b.fix : undefined;
    const base = { ...a };
    delete base.fix;
    merged.set(identity, {
      ...first,
      ...(first.why === undefined && entry.why !== undefined ? { why: entry.why } : {}),
      finding: {
        ...base,
        sources: [...new Set([...(a.sources ?? [a.source]), b.source, ...(b.sources ?? [])])],
        severity: SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b.severity : a.severity,
        state: mergeState(a.state, b.state),
        ...(fix === undefined ? {} : { fix }),
      },
    });
  }
  return [...merged.values()];
}
