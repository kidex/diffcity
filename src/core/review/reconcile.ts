// The outdated rule (ADR-028), pure. A `current` mark becomes `outdated` when
// its target is missing from the new fingerprints, or its fingerprint differs
// from the one stored with the mark. An `outdated` mark is never looked at
// again, so it stays outdated when the content returns to the marked bytes.

import type { Fingerprints } from '../model/types.js';
import { fileFingerprint } from './targets.js';
import type { StoredMark, TargetRef } from './types.js';

/** The fingerprint `fingerprints` holds for a target; null when it has no entry. */
export function currentFingerprint(fingerprints: Fingerprints, ref: TargetRef): string | null {
  if (ref.kind === 'file') {
    const entry = Object.hasOwn(fingerprints.files, ref.id) ? fingerprints.files[ref.id] : undefined;
    return entry === undefined ? null : fileFingerprint(entry);
  }
  return Object.hasOwn(fingerprints.symbols, ref.id) ? (fingerprints.symbols[ref.id] ?? null) : null;
}

/** The targets of `marks` that become outdated against the new snapshot's `fingerprints`. */
export function reconcileMarks(marks: readonly StoredMark[], fingerprints: Fingerprints): TargetRef[] {
  const outdated: TargetRef[] = [];
  for (const mark of marks) {
    if (mark.state !== 'current') continue;
    const ref: TargetRef = { kind: mark.targetKind, id: mark.targetId };
    if (currentFingerprint(fingerprints, ref) !== mark.fingerprint) outdated.push(ref);
  }
  return outdated;
}
