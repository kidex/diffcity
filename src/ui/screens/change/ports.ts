// The optional interfaces the change screen takes (ADR-026). Types only: the
// screen works fully without any of them (ADR-002), and the SPA builds the
// ones it has data for in src/ui/app/ from src/ui/data/. The HTML export
// passes none.

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
