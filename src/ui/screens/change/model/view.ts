// The mockup's filter rules and the paint state they produce (ADR-026). Pure:
// no DOM and no three.js, unit-tested in Node. The scene only maps a
// PaintState to attributes (dim, type match, hover, selection, pulse, check).
//
// - the verdict, type and rule filters combine with AND;
// - a type filter dims the floors of other types and the buildings with no
//   matching floor;
// - a rule filter dims the buildings with no finding of that rule;
// - clicking an active filter turns it off; "Show everything" clears every row;
// - "Hide checked" dims the files and floors with a current review mark, and
//   combines with the rows above with AND too.

import type { Report, Status, Verdict } from '../../../../core/report/types.js';
import type { City, CityBuilding } from './city.js';
import type { Critical, Marks, PulseColor } from './critical.js';
import { floorMark } from './critical.js';

/** The statuses a type filter can select: `same` floors are never a type. */
export type ChangedStatus = Exclude<Status, 'same'>;

export interface Filters {
  verdict: Verdict | null;
  type: ChangedStatus | null;
  /** A rule id, the part of a finding's `source` after `rule:`. */
  rule: string | null;
  /**
   * "Hide checked" (ADR-028, SPEC.md section 6): files and floors with a current review mark are
   * dimmed like the other filters do. Absent when off, so the three rows keep their shape.
   */
  hideChecked?: true;
}

export const NO_FILTERS: Filters = { verdict: null, type: null, rule: null };

export const anyFilter = (filters: Filters): boolean =>
  filters.verdict !== null || filters.type !== null || filters.rule !== null || filters.hideChecked === true;

/** Clicking the active chip turns the row off; any other chip selects it. */
export const toggleVerdict = (filters: Filters, verdict: Verdict): Filters => ({ ...filters, verdict: filters.verdict === verdict ? null : verdict });
export const toggleType = (filters: Filters, type: ChangedStatus): Filters => ({ ...filters, type: filters.type === type ? null : type });
export const toggleRule = (filters: Filters, rule: string): Filters => ({ ...filters, rule: filters.rule === rule ? null : rule });

/** The "Hide checked" chip: on, or off again. */
export function toggleHideChecked(filters: Filters): Filters {
  const { hideChecked, ...rest } = filters;
  return hideChecked === true ? rest : { ...rest, hideChecked: true };
}

/** "Show everything": every row off, "Hide checked" too. */
export const clearFilters = (): Filters => ({ ...NO_FILTERS });

/** The rule id of a finding source (`rule:file-size` gives `file-size`), or null for any other source. */
export function ruleOf(source: string): string | null {
  return source.startsWith('rule:') && source.length > 5 ? source.slice(5) : null;
}

/**
 * Which files have a finding of which rule, from the Report's findings. A
 * change-level finding (file '') belongs to no building and is left out.
 */
export type RuleIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function ruleIndex(report: Pick<Report, 'findings'>): RuleIndex {
  const index = new Map<string, Set<string>>();
  for (const finding of report.findings) {
    const rule = ruleOf(finding.source);
    if (rule === null || finding.file === '' || finding.state !== 'open') continue;
    let files = index.get(rule);
    if (files === undefined) {
      files = new Set();
      index.set(rule, files);
    }
    files.add(finding.file);
  }
  return index;
}

/** A filter that names a rule the Report no longer has is dropped (after a live update). */
export const pruneFilters = (filters: Filters, rules: RuleIndex): Filters =>
  filters.rule !== null && !rules.has(filters.rule) ? { ...filters, rule: null } : filters;

export type Checked = 'none' | 'checked' | 'good' | 'rewrite' | 'outdated';

export interface PaintState {
  /** Drawn faint: filtered out. */
  dimmed: boolean;
  /** No type filter, or the floor has that type (a building: some floor has it). */
  typeMatch: boolean;
  hovered: boolean;
  selected: boolean;
  /** The floor is the one a click or the reading panel focused (a symbol): only its floor, in the selected building. */
  focused: boolean;
  /** The floor pulses (DC-50, model/critical.ts); for a building, its roof strip does. */
  pulse: boolean;
  /** The colour a pulse takes. */
  pulseColor: PulseColor;
  /** The review mark (ADR-028): of a floor, its own or its file's; of a building, the file's, or what its floors add up to. */
  checked: Checked;
}

export interface CityPaint {
  /** By `CityBuilding.index`. */
  buildings: PaintState[];
  /** By building index, then `CityFloor.index`. */
  floors: PaintState[][];
}

export interface PaintInput {
  city: City;
  filters: Filters;
  rules: RuleIndex;
  hover: string | null;
  selection: string | null;
  /** The floors that pulse, by file id (`criticalFloors`); none without it. */
  critical?: ReadonlyMap<string, Critical> | undefined;
  /** The review marks; none without them. */
  marks?: Marks | undefined;
}

const base = (): PaintState => ({
  dimmed: false,
  typeMatch: true,
  hovered: false,
  selected: false,
  focused: false,
  pulse: false,
  pulseColor: 'high',
  checked: 'none',
});

/** What a building's marks add up to: a rewrite anywhere, else its file's mark, else every changed floor checked or good. */
function buildingMark(building: CityBuilding, floors: readonly Checked[], marks: Marks | undefined): Checked {
  if (floors.includes('rewrite')) return 'rewrite';
  const own = marks?.files?.get(building.id);
  if (own !== undefined) return own;
  const changed = building.floors.flatMap((floor, i) => (floor.status === 'same' ? [] : [floors[i] ?? 'none']));
  if (changed.length > 0 && changed.every((mark) => mark === 'checked' || mark === 'good')) return changed.every((mark) => mark === 'good') ? 'good' : 'checked';
  return 'none';
}

const current = (mark: Checked): boolean => mark === 'checked' || mark === 'good' || mark === 'rewrite';

/**
 * Whether "Hide checked" hides the building: its file has a current mark, or
 * every changed floor has one (its own or the file's). An outdated mark counts
 * as none (ADR-028), and a building with no changed floor is never hidden.
 */
function checkedAway(building: CityBuilding, floors: readonly Checked[], marks: Marks | undefined): boolean {
  if (current(marks?.files?.get(building.id) ?? 'none')) return true;
  const changed = building.floors.flatMap((floor, i) => (floor.status === 'same' ? [] : [floors[i] ?? 'none']));
  return changed.length > 0 && changed.every(current);
}

/** Whether `building` passes the verdict and rule rows of `filters`. */
function passesRows(building: CityBuilding, filters: Filters, rules: RuleIndex): boolean {
  if (filters.verdict !== null && building.verdict !== filters.verdict) return false;
  if (filters.rule !== null && rules.get(filters.rule)?.has(building.file.path) !== true) return false;
  return true;
}

/** The paint state of every building and floor of `city` for the filters, hover and selection. */
export function paintCity(input: PaintInput): CityPaint {
  const { city, filters, rules, hover, selection, critical, marks } = input;
  const buildings: PaintState[] = [];
  const floors: PaintState[][] = [];
  for (const building of city.buildings) {
    const type = filters.type;
    const typeMatch = type === null || building.floors.some((floor) => floor.status === type);
    const marked = building.floors.map((floor): Checked => floorMark(marks, building.file, floor) ?? 'none');
    const hidden = filters.hideChecked === true && checkedAway(building, marked, marks);
    const dimmed = !passesRows(building, filters, rules) || !typeMatch || hidden;
    const hovered = building.id === hover;
    const selected = building.id === selection;
    const hot = critical?.get(building.id);
    const pulseColor = hot?.color ?? 'high';
    buildings[building.index] = { ...base(), dimmed, typeMatch, hovered, selected, pulse: hot?.roof === true, pulseColor, checked: buildingMark(building, marked, marks) };
    floors[building.index] = building.floors.map((floor, i) => {
      const match = type === null || floor.status === type;
      const floorHidden = filters.hideChecked === true && current(marked[i] ?? 'none');
      return { ...base(), dimmed: dimmed || !match || floorHidden, typeMatch: match, hovered, selected, pulse: hot?.floors.has(i) === true, pulseColor, checked: marked[i] ?? 'none' };
    });
  }
  return { buildings, floors };
}

/**
 * `base` (the paint for the filters alone) with hover and selection laid
 * over it: only the hovered and the selected building change, so a pointer
 * move does not repaint the city. `focus` is a symbol id: its floor, in the
 * selected building, is painted as focused.
 */
export function focusPaint(
  base: CityPaint,
  city: City,
  hover: string | null,
  selection: string | null,
  focus: string | null = null,
  hoverFloor: { id: string; symbolId: string } | null = null,
): CityPaint {
  const buildings = base.buildings.slice();
  const floors = base.floors.slice();
  for (const id of new Set([hover, selection, hoverFloor?.id ?? null])) {
    const building = id === null ? undefined : city.byId.get(id);
    const state = building === undefined ? undefined : base.buildings[building.index];
    if (building === undefined || state === undefined) continue;
    const hovered = id === hover;
    const selected = id === selection;
    buildings[building.index] = { ...state, hovered, selected };
    floors[building.index] = (base.floors[building.index] ?? []).map((floor, i) => ({
      ...floor,
      hovered,
      selected,
      focused:
        (selected && focus !== null && building.floors[i]?.symbolId === focus) ||
        (hoverFloor !== null && id === hoverFloor.id && building.floors[i]?.symbolId === hoverFloor.symbolId),
    }));
  }
  return { buildings, floors };
}
