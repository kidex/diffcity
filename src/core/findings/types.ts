// Findings pipeline contracts (ADR-036). Pure data: no I/O in src/core/findings.

import type { Finding, Symbol } from '../report/types.js';

export type FindingSeverity = Finding['severity'];
export type FindingCategory = Finding['category'];
export type FindingState = Finding['state'];

export const SEVERITIES: readonly FindingSeverity[] = ['high', 'med', 'low'];
export const CATEGORIES: readonly FindingCategory[] = [
  'security',
  'correctness',
  'scope',
  'style',
  'tests',
  'architecture',
];
export const STATES: readonly FindingState[] = ['open', 'intended', 'fixed'];

/** Import limits (ADR-036). Sizes are bytes of UTF-8. */
export const LIMITS = {
  findings: 5_000,
  message: 16 * 1024,
  title: 4 * 1024,
  fix: 4 * 1024,
  why: 4 * 1024,
} as const;

/** A normalized finding as imported, before anchoring. Both formats end up here. */
export interface FindingInput {
  /** The own-format `id`, kept as an alias of the finding key. */
  id?: string;
  source: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** Repo-relative, `/` separators, no `..`. */
  file: string;
  /** 1-based line in the after version. */
  line: number;
  title: string;
  message: string;
  fix?: string;
  /** One-line reading hint for the execution path (ADR-034); own format only, whitespace collapsed. */
  why?: string;
  state?: FindingState;
}

export interface ParseWarning {
  /** Where in the input, such as `findings[2]` or `runs[0].results[5]`. */
  at: string;
  message: string;
}

export type ParseResult =
  | {
      ok: true;
      findings: FindingInput[];
      warnings: ParseWarning[];
      /**
       * The sources this import covers, in order of first appearance; `fixed`
       * runs for these (pass them to `fixedKeys`). SARIF: the driver name (or
       * `sarif`) of every run with a `results` array, also an empty one or one
       * whose results were all skipped. Own format: the distinct sources of the
       * valid entries, also those skipped for their path.
       */
      sources: string[];
    }
  | { ok: false; errors: string[] };

/** What a finding is anchored to, kept with it so a later head can re-anchor it. */
export interface FindingAnchor {
  /** `Symbol.name` of the anchored symbol; absent at file level. */
  symbolName?: string;
  symbolKind?: Symbol['kind'];
  /** The symbol's first line when the finding was imported, to carry the line over a shift. */
  symbolStart?: number;
  /** Fingerprint of the symbol (or of the file, at file level) when imported; null when unknown (ADR-027). */
  fingerprint: string | null;
}

/**
 * A finding as stored in the table: the overlay view plus what re-anchoring and `fixed` need.
 * The store must return stored findings in import order: `dedup` keeps the
 * first part's key, `source`, message and anchor, so a different order gives
 * a different merged entry.
 */
export interface StoredFinding {
  /** `f:<16 hex>`; also `finding.id`. */
  key: string;
  /** The own-format `id`, when given. */
  alias?: string;
  why?: string;
  finding: Finding;
  anchor: FindingAnchor;
}

export type AnchorResult =
  | { ok: true; stored: StoredFinding }
  | { ok: false; reason: 'skipped-not-in-change' };
