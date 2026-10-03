// Review progress (ADR-028), pure. An outdated mark counts as unchecked.

import type { ReviewMark, ReviewProgress } from '../model/types.js';
import type { File, Report } from '../report/types.js';

type Counter = { done: number; total: number };

export function computeProgress(report: Report, marks: readonly ReviewMark[]): ReviewProgress {
  const fileMarks = new Set<string>();
  const symbolMarks = new Set<string>();
  let rewrite = 0;
  let outdated = 0;
  for (const mark of marks) {
    if (mark.state === 'outdated') {
      outdated += 1;
      continue;
    }
    if (mark.mark === 'rewrite') rewrite += 1;
    (mark.targetKind === 'file' ? fileMarks : symbolMarks).add(mark.targetId);
  }

  const isDone = (file: File): boolean => {
    if (fileMarks.has(file.id)) return true;
    const changed = file.symbols.filter((symbol) => symbol.status !== 'same');
    return changed.length > 0 && changed.every((symbol) => symbolMarks.has(symbol.id));
  };

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
  return { attention, touched, rewrite, outdated, allAttentionDone: attention.total > 0 && attention.done === attention.total };
}
