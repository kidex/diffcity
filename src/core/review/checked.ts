// Whether a file counts as checked by the review marks (ADR-028), pure. Shared
// by the HUD's progress and the server's Approve gate (ADR-036).

import type { ReviewMark } from '../model/types.js';
import type { File } from '../report/types.js';

/**
 * Whether a file counts as checked: a current mark on the file, or a current
 * mark on every changed symbol of it (an outdated mark counts as unchecked).
 */
export function fileCheckedBy(marks: readonly ReviewMark[]): (file: File) => boolean {
  const fileMarks = new Set<string>();
  const symbolMarks = new Set<string>();
  for (const mark of marks) {
    if (mark.state === 'outdated') continue;
    (mark.targetKind === 'file' ? fileMarks : symbolMarks).add(mark.targetId);
  }
  return (file) => {
    if (fileMarks.has(file.id)) return true;
    const changed = file.symbols.filter((symbol) => symbol.status !== 'same');
    return changed.length > 0 && changed.every((symbol) => symbolMarks.has(symbol.id));
  };
}
