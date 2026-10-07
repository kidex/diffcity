// The Approve gate (SPEC.md section 6, ADR-036), pure: a change can be
// approved only when every touched tier 1 file has a current review mark. The
// daemon checks it from the latest snapshot and the stored marks, never from
// what a client says.

import type { ReviewMark } from '../model/types.js';
import type { Report } from '../report/types.js';
import { fileCheckedBy } from './progress.js';

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
