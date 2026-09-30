// File verdict, SPEC.md section 5.2 and ADR-009.

import type { File, Finding, Status, Verdict } from '../report/types.js';

export interface FileVerdictInput {
  /** File status (SPEC.md 5.1, ADR-005/008). `same` means untouched. */
  status: Status;
  /** Statuses of the file's symbols. */
  symbolStatuses: readonly Status[];
  /** Whether the file path is in a tier 1 zone. */
  tier1: boolean;
  /** Findings anchored to this file. */
  findings: readonly Pick<Finding, 'severity' | 'state'>[];
  /** `null` when there is no spec (always in phase 1, ADR-010). */
  inSpec: boolean | null;
}

/**
 * Decides the verdict of one file. An untouched file is `same`, checked first;
 * otherwise the first match wins: `eyes` (tier 1 or at least one `sig` symbol),
 * `risky` (at least one open high finding), `spec` (`inSpec === false`), `ok`.
 * Findings in state `intended` or `fixed` do not count.
 */
export function fileVerdict(input: FileVerdictInput): Verdict {
  if (input.status === 'same') return 'same';
  if (input.tier1 || input.symbolStatuses.includes('sig')) return 'eyes';
  if (input.findings.some((finding) => finding.state === 'open' && finding.severity === 'high')) {
    return 'risky';
  }
  if (input.inSpec === false) return 'spec';
  return 'ok';
}

/** `summary.tier1Files`: paths of touched tier 1 files, sorted. */
export function touchedTier1Files(
  files: readonly Pick<File, 'path' | 'status'>[],
  isTier1: (path: string) => boolean,
): string[] {
  return files
    .filter((file) => file.status !== 'same' && isTier1(file.path))
    .map((file) => file.path)
    .sort();
}
