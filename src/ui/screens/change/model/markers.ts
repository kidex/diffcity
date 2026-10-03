// Where the finding markers go (ADR-026, DC-52): a pin on the roof for every
// open finding; an X instead of a pin when the finding's source starts with
// `rule:`, on the floor of its symbol or on the roof when it has none. A
// change-level finding (file ''), one on a file that is not in the city and one
// that is not open (fixed, intended) get none. Pure: no three.js, no DOM.

import type { Finding } from '../../../../core/report/types.js';
import type { City } from './city.js';
import { ruleOf } from './view.js';

export interface FindingMarker {
  kind: 'pin' | 'x';
  /** The building's file id. */
  file: string;
  /** The floor it sits on, or null for the roof. */
  floor: number | null;
  severity: Finding['severity'];
  /** Position among the markers that share its spot (one roof, or one floor), left to right. */
  slot: number;
  findingId: string;
}

/** The markers of `findings` in `city`, in the findings' order. */
export function findingMarkers(city: City, findings: readonly Finding[]): FindingMarker[] {
  const byPath = new Map(city.buildings.map((building) => [building.file.path, building]));
  const used = new Map<string, number>();
  const markers: FindingMarker[] = [];
  for (const finding of findings) {
    // Only open findings are drawn: fixed and intended ones leave the city.
    if (finding.file === '' || finding.state !== 'open') continue;
    const building = byPath.get(finding.file);
    if (building === undefined) continue;
    const rule = ruleOf(finding.source) !== null;
    const floor = rule && finding.symbolId !== undefined ? (building.floors.find((candidate) => candidate.symbolId === finding.symbolId)?.index ?? null) : null;
    const spot = `${building.id}\n${floor === null ? 'roof' : String(floor)}`;
    const slot = used.get(spot) ?? 0;
    used.set(spot, slot + 1);
    markers.push({ kind: rule ? 'x' : 'pin', file: building.id, floor, severity: finding.severity, slot, findingId: finding.id });
  }
  return markers;
}
