// Review progress (ADR-028), pure. An outdated mark counts as unchecked.

import type { ReviewMark, ReviewProgress } from '../model/types.js';
import type { Report } from '../report/types.js';
import { uncheckedTier1Files } from './approve.js';
import { fileCheckedBy } from './checked.js';

type Counter = { done: number; total: number };

export { fileCheckedBy };

export function computeProgress(report: Report, marks: readonly ReviewMark[]): ReviewProgress {
  let rewrite = 0;
  let outdated = 0;
  for (const mark of marks) {
    if (mark.state === 'outdated') outdated += 1;
    else if (mark.mark === 'rewrite') rewrite += 1;
  }
  const isDone = fileCheckedBy(marks);

  const attention: Counter = { done: 0, total: 0 };
  const touched: Counter = { done: 0, total: 0 };
  for (const pkg of report.packages) {
    for (const file of pkg.files) {
      if (file.status === 'same') continue;
      const done = isDone(file);
      touched.total += 1;
      if (done) touched.done += 1;
      if (file.verdict === 'eyes' || file.verdict === 'risky') {
        attention.total += 1;
        if (done) attention.done += 1;
      }
    }
  }
  // The same rule as the server's Approve gate, so `done === total` exactly
  // when POST /approve would be accepted (zero tier 1 files included).
  const tier1Total = report.summary.tier1Files.length;
  const tier1: Counter = { done: tier1Total - uncheckedTier1Files(report, marks).length, total: tier1Total };
  return {
    attention,
    touched,
    tier1,
    rewrite,
    outdated,
    allAttentionDone: attention.total > 0 && attention.done === attention.total,
  };
}
