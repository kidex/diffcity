import type { Fingerprints } from '../model/types.js';
import type { Report } from '../report/types.js';
import { findFile, reanchor, symbolByName } from './anchor.js';
import { dedupIdentity } from './dedup.js';
import type { StoredFinding } from './types.js';

/**
 * Keys of the stored findings an import closes as `fixed` (docs/findings.md).
 * A stored `open` finding of a source the import covers, which the import did
 * not report again, is fixed when its file left the change or its anchor's
 * fingerprint differs from the one stored at import. An unchanged anchor, or
 * a stored fingerprint that is unknown, leaves it open. A snapshot alone never
 * fixes anything: this runs on an import only.
 *
 * `imported` are the findings of the new import, anchored on `report`;
 * `sources` are the sources the import covers: pass `ParseResult.sources`,
 * so a tool run that reported nothing still fixes its findings. It defaults
 * to the sources found in `imported`.
 */
export function fixedKeys(args: {
  stored: readonly StoredFinding[];
  imported: readonly StoredFinding[];
  report: Report;
  fingerprints: Fingerprints;
  sources?: readonly string[];
}): string[] {
  const { stored, imported, report, fingerprints } = args;
  const covered = new Set(args.sources ?? imported.map((entry) => entry.finding.source));
  const reportedKeys = new Set(imported.map((entry) => entry.key));
  const reportedIdentities = new Set(imported.map((entry) => dedupIdentity(entry.finding)));

  const keys: string[] = [];
  for (const entry of stored) {
    if (entry.finding.state !== 'open' || !covered.has(entry.finding.source)) continue;
    if (reportedKeys.has(entry.key)) continue;
    const current = reanchor(entry, report);
    if (current === null) {
      keys.push(entry.key);
      continue;
    }
    if (reportedIdentities.has(dedupIdentity(current))) continue;
    const file = findFile(report, entry.finding.file);
    if (file === undefined) continue;
    const { symbolName, symbolKind, symbolStart, fingerprint } = entry.anchor;
    if (fingerprint === null) continue;
    let now: string | null;
    if (symbolName !== undefined && symbolKind !== undefined) {
      const symbol = symbolByName(file, symbolName, symbolKind, symbolStart ?? entry.finding.line);
      now = symbol === undefined ? null : (fingerprints.symbols[symbol.id] ?? null);
    } else {
      now = fingerprints.files[file.id]?.after ?? null;
    }
    if (now !== fingerprint) keys.push(entry.key);
  }
  return keys;
}
