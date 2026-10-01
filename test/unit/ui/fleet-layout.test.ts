// ui/fleet-layout (SPEC.md section 6, ADR-022): lot side ∝ √(unreviewed + 1)
// within limits, rows that fit the width in list order on a common baseline,
// and labels shortened to the cell.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  fitLabel,
  layoutLots,
  LOT_MAX,
  LOT_UNIT,
  lotSide,
  type LotPlacement,
} from '../../../src/ui/screens/fleet/layout.js';

function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

const bottom = (lot: LotPlacement): number => lot.y + lot.side;

describe('ui/fleet-layout', () => {
  describe('lot side', () => {
    it('is the unit with no unreviewed change', () => {
      expect(lotSide(0)).toBe(LOT_UNIT);
    });
    it('grows with the square root of unreviewed + 1', () => {
      expect(lotSide(3)).toBe(LOT_UNIT * 2);
      expect(lotSide(1)).toBe(Math.round(LOT_UNIT * Math.SQRT2));
    });
    it('is strictly larger for more unreviewed changes below the cap', () => {
      const sides = [0, 1, 2, 3, 5, 8].map(lotSide);
      for (let i = 1; i < sides.length; i++) expect(at(sides, i)).toBeGreaterThan(at(sides, i - 1));
    });
    it('stops at the cap', () => {
      expect(lotSide(8)).toBe(LOT_MAX);
      expect(lotSide(500)).toBe(LOT_MAX);
    });
    it('treats a negative or non-finite count as zero', () => {
      expect(lotSide(-2)).toBe(LOT_UNIT);
      expect(lotSide(Number.NaN)).toBe(LOT_UNIT);
    });
  });

  describe('placement', () => {
    const lots = [
      { id: 1, side: 128 },
      { id: 2, side: 91 },
      { id: 3, side: 64 },
    ];

    it('keeps the list order, left to right', () => {
      const placed = layoutLots(lots, 1200).lots;
      expect(placed.map((lot) => lot.id)).toEqual([1, 2, 3]);
      expect(at(placed, 0).x).toBeLessThan(at(placed, 1).x);
      expect(at(placed, 1).x).toBeLessThan(at(placed, 2).x);
    });

    it('stands every lot of a row on the same baseline', () => {
      const placed = layoutLots(lots, 1200).lots;
      expect(new Set(placed.map(bottom)).size).toBe(1);
    });

    it('centres a row that does not fill the width', () => {
      const width = 1200;
      const placed = layoutLots(lots, width).lots;
      const first = at(placed, 0);
      const last = at(placed, -1);
      const left = first.x - (first.cell - first.side) / 2;
      const right = last.x + last.side + (last.cell - last.side) / 2;
      expect(Math.abs(left - (width - right))).toBeLessThanOrEqual(1);
    });

    it('wraps to a new row when the width is used up', () => {
      const width = 2 * DEFAULT_LAYOUT.padX + 2 * DEFAULT_LAYOUT.minCell + DEFAULT_LAYOUT.gapX;
      const placed = layoutLots(lots, width).lots;
      expect(at(placed, 2).y).toBeGreaterThan(bottom(at(placed, 0)));
      expect(bottom(at(placed, 0))).toBe(bottom(at(placed, 1)));
    });

    it('never places a lot over the title or the legend', () => {
      const layout = layoutLots(lots, 400);
      for (const lot of layout.lots) {
        expect(lot.y).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.padTop);
        expect(bottom(lot) + DEFAULT_LAYOUT.label).toBeLessThanOrEqual(layout.height - DEFAULT_LAYOUT.padBottom);
      }
    });

    it('gives the same placement for the same input', () => {
      expect(layoutLots(lots, 900)).toEqual(layoutLots(lots, 900));
    });

    it('has only the paddings when there is no lot', () => {
      expect(layoutLots([], 900)).toEqual({ lots: [], height: DEFAULT_LAYOUT.padTop + DEFAULT_LAYOUT.padBottom });
    });
  });

  describe('labels', () => {
    it('keeps a name that fits', () => {
      expect(fitLabel('sample-shop', 20)).toBe('sample-shop');
    });
    it('shortens a long name with an ellipsis', () => {
      expect(fitLabel('a-very-long-repository-name', 10)).toBe('a-very-lo…');
    });
  });
});
