// The markable targets of a snapshot (ADR-028): touched files (status other
// than `same`) and every symbol of a touched file, each with the fingerprint
// it has in that snapshot (ADR-027). Pure.

import type { FileFingerprint, Fingerprints } from '../model/types.js';
import type { Report } from '../report/types.js';
import type { TargetRef } from './types.js';

export interface Target {
  kind: 'file' | 'symbol';
  id: string;
  /** The file the target is in. */
  filePath: string;
  /** The symbol's name; null for a file. */
  name: string | null;
  fingerprint: string;
}

/** A file's fingerprint as one string: both sides, so a base move changes it too. */
export function fileFingerprint(entry: FileFingerprint): string {
  return `${entry.before ?? ''}|${entry.after ?? ''}`;
}

export function targetKey(ref: TargetRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * The markable targets of `report`, keyed by targetKey. A target without an
 * entry in `fingerprints` is not markable (there is nothing to compare later).
 */
export function markableTargets(report: Report, fingerprints: Fingerprints): Map<string, Target> {
  const targets = new Map<string, Target>();
  for (const pkg of report.packages) {
    for (const file of pkg.files) {
      if (file.status === 'same') continue;
      const entry = fingerprints.files[file.id];
      if (entry === undefined) continue;
      targets.set(targetKey({ kind: 'file', id: file.id }), {
        kind: 'file',
        id: file.id,
        filePath: file.path,
        name: null,
        fingerprint: fileFingerprint(entry),
      });
      for (const symbol of file.symbols) {
        const fingerprint = fingerprints.symbols[symbol.id];
        if (fingerprint === undefined) continue;
        targets.set(targetKey({ kind: 'symbol', id: symbol.id }), {
          kind: 'symbol',
          id: symbol.id,
          filePath: file.path,
          name: symbol.name,
          fingerprint,
        });
      }
    }
  }
  return targets;
}
