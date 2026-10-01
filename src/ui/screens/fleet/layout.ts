// Placement of the Fleet lots (ADR-022): presentational only. The side of a
// lot grows with √(unreviewed + 1) within fixed limits; lots flow in rows in
// the order of the list (the API order), standing on a common baseline like
// buildings on a street, and every row is centred. The placement depends
// only on the list and the width, so a live update moves a lot only when its
// count or its place in the list changes.

/** Side of a lot with no unreviewed change, in px; also the unit of growth. */
export const LOT_UNIT = 64;
/** The largest lot: 8 unreviewed changes and more all reach it. */
export const LOT_MAX = 192;

/** Lot side in px for a repo's unreviewed count: ∝ √(unreviewed + 1), clamped to [LOT_UNIT, LOT_MAX]. */
export function lotSide(unreviewed: number): number {
  const count = Number.isFinite(unreviewed) && unreviewed > 0 ? unreviewed : 0;
  return Math.round(Math.min(LOT_MAX, Math.max(LOT_UNIT, LOT_UNIT * Math.sqrt(count + 1))));
}

export interface LayoutOptions {
  /** Room around the lots: top (the title), sides, bottom (the gap above the legend, which follows the map). */
  padTop: number;
  padX: number;
  padBottom: number;
  /** The narrowest cell: room for the name label under a small lot. */
  minCell: number;
  /** Room kept free on each side of a lot inside its cell, so big neighbours never touch. */
  margin: number;
  /** Space between cells in a row and between rows. */
  gapX: number;
  gapY: number;
  /** Height of the labels under each lot. */
  label: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  padTop: 104,
  padX: 32,
  padBottom: 20,
  minCell: 156,
  margin: 16,
  gapX: 20,
  gapY: 18,
  label: 48,
};

export interface LotInput {
  id: number;
  side: number;
}

export interface LotPlacement {
  id: number;
  side: number;
  /** Top-left corner of the lot. */
  x: number;
  y: number;
  /** Width of the cell the lot is centred in. */
  cell: number;
  /** Width the name and sub-labels may use, centred under the lot: the cell less its margins. */
  label: number;
}

export interface MapLayout {
  lots: LotPlacement[];
  height: number;
}

/** Places `lots` in rows that fit `width`; the map height follows the rows. */
export function layoutLots(lots: readonly LotInput[], width: number, options: LayoutOptions = DEFAULT_LAYOUT): MapLayout {
  const inner = Math.max(options.minCell, width - 2 * options.padX);
  const rows: { cells: { lot: LotInput; cell: number }[]; width: number; tallest: number }[] = [];
  for (const lot of lots) {
    const cell = Math.max(options.minCell, lot.side + 2 * options.margin);
    let row = rows.at(-1);
    if (!row || row.width + options.gapX + cell > inner) {
      row = { cells: [], width: -options.gapX, tallest: 0 };
      rows.push(row);
    }
    row.cells.push({ lot, cell });
    row.width += options.gapX + cell;
    row.tallest = Math.max(row.tallest, lot.side);
  }

  const placed: LotPlacement[] = [];
  let top = options.padTop;
  for (const row of rows) {
    let left = options.padX + Math.max(0, (inner - row.width) / 2);
    for (const { lot, cell } of row.cells) {
      placed.push({
        id: lot.id,
        side: lot.side,
        x: Math.round(left + (cell - lot.side) / 2),
        y: Math.round(top + row.tallest - lot.side),
        cell,
        label: cell - 2 * options.margin,
      });
      left += cell + options.gapX;
    }
    top += row.tallest + options.label + options.gapY;
  }
  const content = rows.length === 0 ? 0 : top - options.gapY - options.padTop;
  return { lots: placed, height: Math.round(options.padTop + content + options.padBottom) };
}

/**
 * `name` shortened with an ellipsis to at most `maxChars` characters, for a
 * label in a monospace font under a lot. The full name stays in the
 * accessible label and the tooltip.
 */
export function fitLabel(name: string, maxChars: number): string {
  const limit = Math.max(2, Math.floor(maxChars));
  const chars = Array.from(name);
  return chars.length <= limit ? name : `${chars.slice(0, limit - 1).join('')}…`;
}
