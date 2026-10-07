// The optional interfaces the change screen takes (ADR-026). Types only: the
// screen works fully without any of them (ADR-002), and the SPA builds the
// ones it has data for in src/ui/app/ from src/ui/data/. The HTML export
// passes none.

import type { FileDiff, ReviewMark, ReviewMarkValue, ReviewProgress } from '../../../core/model/types.js';

/**
 * What the file view reads to show the diff of one file (ADR-027). Structurally
 * the port of src/ui/data/diff-port.ts, which the SPA builds; the screen never
 * imports src/ui/data. Without it the file view shows only the Report's step
 * diffs, with "Full diff is available in the app".
 */
export interface DiffPort {
  /**
   * The diff of file `path` (a `File.id`) of the latest snapshot; with `symbolId`
   * (a `Symbol.id` of that file) the answer also carries `focus`.
   */
  fileDiff(path: string, symbolId?: string, signal?: AbortSignal): Promise<FileDiff>;
}

/** The marks, general note and progress of a change (ADR-028). */
export interface ReviewState {
  snapshotId: number;
  marks: ReviewMark[];
  note: string | null;
  progress: ReviewProgress;
}

/** A mark to make: the snapshot is the one the reviewer is looking at. */
export interface MarkRequest {
  snapshotId: number;
  target: { kind: 'file' | 'symbol'; id: string };
  mark: ReviewMarkValue;
  note?: string;
  lines?: { side: 'old' | 'new'; start: number; end: number };
}

/**
 * What the screen reads and writes of the review marks (ADR-028). Structurally
 * the port of src/ui/data/review-port.ts. Without it there are no mark buttons,
 * no progress and no "hide checked".
 */
export interface ReviewPort {
  /** The marks, note and progress now; null while the change has no snapshot. */
  load(signal?: AbortSignal): Promise<ReviewState | null>;
  setMark(request: MarkRequest): Promise<{ mark: ReviewMark; progress: ReviewProgress }>;
  clearMark(target: MarkRequest['target']): Promise<void>;
  setNote(note: string): Promise<{ note: string | null }>;
  /** The markdown summary of the "Needs rewrite" marks; null while there is no snapshot. */
  summary(signal?: AbortSignal): Promise<string | null>;
  /** Calls `listener` when the marks of this change moved; returns the function that stops it. */
  onChange(listener: () => void): () => void;
}

/** One repo in the Fleet card: the mockup's `name  age  bar` row. */
export interface FleetCardRow {
  name: string;
  /** What the row says about the audit, as shown: `3 days`, `47 days, 3 new CVEs`. */
  age: string;
  /** Red above 30 days or with new CVEs, amber in between, green when fresh. */
  level: 'fresh' | 'aging' | 'stale';
  /** Bar fill, 0 to 1 (age against the 30-day limit). */
  fill: number;
}

/** The last audit of the other repos (SPEC.md section 6, "Fleet (card)"). */
export interface FleetCard {
  rows: FleetCardRow[];
  /** All projects, for "all N projects". */
  total: number;
}

/** Without a FleetPort the card is hidden. */
export interface FleetPort {
  /** The card now; null hides it (nothing to show). */
  card(): FleetCard | null;
  /** Calls `listener` when the card changes; returns the function that stops it. */
  onChange(listener: () => void): () => void;
  /** "all N projects": goes to the Fleet screen. */
  open(): void;
}

/** A finding action the daemon answered with an error (a 409 refusal, 404, 403, ...): its code and the message to show. */
export interface FindingRefusal {
  code: string;
  message: string;
}

/** The daemon's answer to a finding action (`at`: when it arrived, `performance.now()`), or its error. */
export type FindingAnswer<T> = { ok: true; value: T; at: number } | { ok: false; refusal: FindingRefusal };

/**
 * "Ask agent to fix" and "Mark as intended" (ADR-036). Structurally the port of
 * src/ui/data/findings-port.ts. Only a request that got no answer (no daemon,
 * a dropped connection) rejects. Without it the finding cards have no action buttons: the HTML
 * export shows the findings and their state only.
 */
export interface FindingsPort {
  /** Writes finding `key` (a `Finding.id`) to the fix queue; `queued` is false when it was already there. */
  ask(key: string): Promise<FindingAnswer<{ key: string; queued: boolean; count: number }>>;
  /** Sets the state of finding `key`: `intended`, or back to `open` (the undo). */
  setState(key: string, state: 'open' | 'intended'): Promise<FindingAnswer<{ key: string; state: 'open' | 'intended'; keys: string[] }>>;
}
