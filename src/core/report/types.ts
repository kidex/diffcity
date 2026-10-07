// Report data model, identical to SPEC.md section 4.1 (Step with the ADR-034 addition).
// Computed in the daemon, served over the API and embedded in the HTML export.

export type Status = 'add' | 'mod' | 'sig' | 'del' | 'same';
export type Verdict = 'eyes' | 'risky' | 'spec' | 'ok' | 'same';

export interface Report {
  meta: { repo: string; base: string; head: string; commits: number; generatedAt: string };
  packages: Package[];
  /** Execution path. */
  steps: Step[];
  findings: Finding[];
  /** One per configured rule (phase 4). */
  checks?: RuleCheck[];
  summary: {
    files: number;
    byStatus: Record<Status, number>;
    byVerdict: Record<Verdict, number>;
    tier1Files: string[];
  };
}

export interface Package {
  id: string;
  path: string;
  tier1: boolean;
  files: File[];
}

export interface File {
  id: string;
  path: string;
  language: string;
  status: Status;
  verdict: Verdict;
  /** `null` when there is no spec. */
  inSpec: boolean | null;
  symbols: Symbol[];
}

export interface Symbol {
  id: string;
  name: string;
  kind: 'class' | 'function' | 'method' | 'export' | 'sql';
  status: Status;
  range: { start: number; end: number };
  signatureBefore?: string;
  signatureAfter?: string;
  /** How many calls the agent rewrote, for `sig`. */
  callsites?: number;
}

export interface Step {
  /** 1-based, continuous across sections. */
  order: number;
  symbolId: string;
  fileId: string;
  why: string;
  diff: DiffLine[];
  /** ADR-034 addition to section 4.1; a missing section reads as `path`. */
  section?: 'path' | 'migration' | 'unconnected';
  /** Symbol id of the entry point a `path` step hangs from (its own id for the entry itself). */
  entry?: string;
}

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

export interface Finding {
  id: string;
  /** 'claude' | 'semgrep' | 'eslint' | ... */
  source: string;
  severity: 'high' | 'med' | 'low';
  category: 'security' | 'correctness' | 'scope' | 'style' | 'tests' | 'architecture';
  file: string;
  line: number;
  /** Resolved on import. */
  symbolId?: string;
  title: string;
  message: string;
  fix?: string;
  state: 'open' | 'intended' | 'fixed';
}

export interface RuleCheck {
  ruleId: string;
  kind: 'file-size' | 'layers' | 'pipeline' | 'cve';
  state: 'passed' | 'violations' | 'not-checked' | 'pending' | 'error';
  reason?: string;
  findings: number;
  checkedAt: string;
}
