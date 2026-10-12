// The Approve gate (SPEC.md section 6, ADR-036), pure: a change can be
// approved only when every touched tier 1 file has a current review mark. The
// daemon checks it from the latest snapshot and the stored marks, never from
// what a client says.

import type { Fingerprints, ReviewMark } from '../model/types.js';
import type { Report } from '../report/types.js';
import { fileCheckedBy } from './checked.js';
import { markableTargets, targetKey } from './targets.js';
import type { TargetRef } from './types.js';

/**
 * The touched tier 1 files of `report` (`summary.tier1Files`) that are not
 * checked by `marks` (a current mark on the file, or on every changed symbol
 * of it), in `tier1Files` order. Empty when Approve is allowed.
 */
export function uncheckedTier1Files(report: Report, marks: readonly ReviewMark[]): string[] {
  const checked = fileCheckedBy(marks);
  const byPath = new Map(report.packages.flatMap((pkg) => pkg.files.map((file) => [file.path, file] as const)));
  return report.summary.tier1Files.filter((path) => {
    const file = byPath.get(path);
    // A tier 1 path the Report does not list cannot have been marked.
    return file === undefined || !checked(file);
  });
}

/** One Checked file mark that "Check the rest and approve" writes. */
export interface RemainingMark {
  target: TargetRef;
  filePath: string;
  /** The file's fingerprint in the snapshot the marks are written against. */
  fingerprint: string;
}

export interface CheckRemainingPlan {
  /** The touched tier 1 files without a current mark (uncheckedTier1Files), in `tier1Files` order. */
  files: string[];
  /** A Checked mark on each of `files` that is a markable file of the snapshot. */
  marks: RemainingMark[];
  /** The `files` that cannot be marked: missing from the Report's packages or without a fingerprint. */
  unmarkable: string[];
}

/**
 * What "Check the rest and approve" (ADR-028 amendment) writes: a Checked mark
 * on every touched tier 1 file of `report` that has no current mark. Files that
 * already count as checked, by a file mark or by marks on all their changed
 * symbols, keep their marks and get none.
 */
export function checkRemainingPlan(report: Report, fingerprints: Fingerprints, marks: readonly ReviewMark[]): CheckRemainingPlan {
  const files = uncheckedTier1Files(report, marks);
  const targets = markableTargets(report, fingerprints);
  const idByPath = new Map(report.packages.flatMap((pkg) => pkg.files.map((file) => [file.path, file.id] as const)));
  const planned: RemainingMark[] = [];
  const unmarkable: string[] = [];
  for (const path of files) {
    const id = idByPath.get(path);
    const target = id === undefined ? undefined : targets.get(targetKey({ kind: 'file', id }));
    if (target === undefined) {
      unmarkable.push(path);
      continue;
    }
    planned.push({ target: { kind: 'file', id: target.id }, filePath: target.filePath, fingerprint: target.fingerprint });
  }
  return { files, marks: planned, unmarkable };
}
