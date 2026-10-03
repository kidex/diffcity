// Which floors pulse, and how review marks change what is drawn (ADR-026,
// DC-50). Pure presentation: it reads only Report fields and an optional marks
// overlay, decides nothing about a verdict (ADR-022), and has no three.js and
// no DOM, so vitest runs it in Node.
//
// A floor pulses when it is
// - a changed floor (`status !== 'same'`) of a file whose verdict is `eyes` or `risky`;
// - a changed floor of a tier 1 file;
// - a floor with an open `high` finding (`finding.symbolId`).
// A high finding with no symbol (or one the file does not have) pulses the roof strip.
// A floor, or a file, with a current mark (Checked, Looks good, Needs rewrite)
// stops pulsing; an outdated mark looks unchecked, so it does not.

import type { File, Report } from '../../../../core/report/types.js';
import { floorsOf } from './city.js';
import type { CityFloor } from './city.js';

/** The colour a pulse takes: the file's verdict colour for eyes and risky, else the high severity colour. */
export type PulseColor = 'eyes' | 'risky' | 'high';

/** What the scene draws for a review mark (ADR-028). `outdated`: the content changed since the mark. */
export type MarkKind = 'checked' | 'good' | 'rewrite' | 'outdated';

/**
 * The review marks of the change, by file id and by symbol id. The ReviewPort
 * (DC-73) is mapped to this by the screen; without one there are no marks.
 */
export interface Marks {
  files?: ReadonlyMap<string, MarkKind>;
  symbols?: ReadonlyMap<string, MarkKind>;
}

export interface Critical {
  color: PulseColor;
  /** Floor indices (`CityFloor.index`) that pulse. */
  floors: ReadonlySet<number>;
  /** The roof strip pulses. */
  roof: boolean;
}

/** A current mark; an outdated one counts as no mark. */
export const isCurrentMark = (mark: MarkKind | undefined): mark is Exclude<MarkKind, 'outdated'> => mark !== undefined && mark !== 'outdated';

/** The mark of a floor: its symbol's own mark, else the file's. */
export function floorMark(marks: Marks | undefined, file: File, floor: CityFloor): MarkKind | undefined {
  const own = floor.symbolId === null ? undefined : marks?.symbols?.get(floor.symbolId);
  return own ?? marks?.files?.get(file.id);
}

const pulseColorOf = (file: File): PulseColor => (file.verdict === 'eyes' || file.verdict === 'risky' ? file.verdict : 'high');

/**
 * The critical floors of every file that has any, by file id (DC-50). Files
 * with nothing critical are left out.
 */
export function criticalFloors(report: Pick<Report, 'packages' | 'findings'>, marks?: Marks): ReadonlyMap<string, Critical> {
  const high = new Map<string, string[]>();
  const roofOnly = new Set<string>();
  for (const finding of report.findings) {
    if (finding.state !== 'open' || finding.severity !== 'high' || finding.file === '') continue;
    if (finding.symbolId === undefined) roofOnly.add(finding.file);
    else high.set(finding.file, [...(high.get(finding.file) ?? []), finding.symbolId]);
  }

  const result = new Map<string, Critical>();
  for (const pkg of report.packages) {
    for (const file of pkg.files) {
      const fileMark = marks?.files?.get(file.id);
      const floors = floorsOf(file);
      const loud = file.verdict === 'eyes' || file.verdict === 'risky' || pkg.tier1;
      const symbols = new Set(high.get(file.path));
      const pulsing = new Set<number>();
      // A high finding whose symbol is not a floor of the file falls back to the roof.
      let roof = roofOnly.has(file.path);
      for (const symbol of symbols) if (!floors.some((floor) => floor.symbolId === symbol)) roof = true;
      for (const floor of floors) {
        const critical = (loud && floor.status !== 'same') || (floor.symbolId !== null && symbols.has(floor.symbolId));
        const mark = floorMark(marks, file, floor);
        if (critical && !isCurrentMark(mark)) pulsing.add(floor.index);
      }
      if (isCurrentMark(fileMark)) roof = false;
      if (pulsing.size > 0 || roof) result.set(file.id, { color: pulseColorOf(file), floors: pulsing, roof });
    }
  }
  return result;
}

// ---------- the pulse itself ----------

/** One pulse takes this many seconds. */
export const PULSE_PERIOD = 1.6;
/** The strip's gain runs between these multiples of its base gain. */
export const PULSE_MIN = 1;
export const PULSE_MAX = 2.4;
/** The gain of a pulsing floor under reduced motion, which also gets a halo. */
export const PULSE_STILL = 1.8;

/** The gain multiplier of a pulsing strip at `seconds`, for a phase in radians (the shader does the same sum). */
export function pulseGain(seconds: number, phase: number): number {
  const wave = 0.5 + 0.5 * Math.sin((2 * Math.PI * seconds) / PULSE_PERIOD + phase);
  return PULSE_MIN + (PULSE_MAX - PULSE_MIN) * wave;
}

/** A phase in [0, 2π) from a file id: stable across live updates, different from building to building. */
export function phaseOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) * 2 * Math.PI;
}
