// ui/fleet-tip: the Fleet hover card is anchored to its lot. It prefers the
// space above the lot, then below its labels, then beside it, stays inside
// the map, and never covers the lot (lifted face, focus ring) or its labels.

import { describe, expect, it } from 'vitest';
import { layoutLots, LOT_MAX, LOT_UNIT, lotSide, type LotPlacement } from '../../../src/ui/screens/fleet/layout.js';
import { tipPosition } from '../../../src/ui/screens/fleet/map.js';

const TIP = { width: 220, height: 104 };

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the card must never cover: the lot with its 3 px lift and 4 px ring, its side face and two label lines. */
function lotBox(lot: LotPlacement): Box {
  const centre = lot.x + lot.side / 2;
  return {
    left: Math.min(lot.x - 4, centre - lot.label / 2),
    right: Math.max(lot.x + lot.side + 4, centre + lot.label / 2),
    top: lot.y - 7,
    bottom: lot.y + lot.side + 6 + 41,
  };
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function lot(x: number, y: number, side: number): LotPlacement {
  return { id: 1, x, y, side, cell: Math.max(156, side + 32), label: Math.max(156, side + 32) - 32 };
}

describe('ui/fleet-tip', () => {
  it('goes centred above a lot when there is room', () => {
    const place = lot(400, 300, 100);
    const at = tipPosition(place, TIP.width, TIP.height, 1200, 700);
    expect(at.placement).toBe('above');
    expect(at.left + TIP.width / 2).toBe(450);
    expect(at.top + TIP.height).toBeLessThanOrEqual(place.y - 8);
  });

  it('flips below the labels when there is no room above', () => {
    const place = lot(400, 104, 64);
    const at = tipPosition(place, TIP.width, TIP.height, 1200, 700);
    expect(at.placement).toBe('below');
    expect(at.top).toBeGreaterThanOrEqual(place.y + place.side + 6 + 41);
  });

  it('goes beside a big lot when neither above nor below fits', () => {
    const at = tipPosition(lot(400, 104, LOT_MAX), TIP.width, TIP.height, 1200, 408);
    expect(at.placement).toBe('right');
    expect(tipPosition(lot(1200 - 32 - LOT_MAX - 16, 104, LOT_MAX), TIP.width, TIP.height, 1200, 408).placement).toBe('left');
  });

  it('is clamped to the map edges', () => {
    const atLeft = tipPosition(lot(32, 300, LOT_UNIT), TIP.width, TIP.height, 1200, 700);
    expect(atLeft.left).toBe(8);
    const atRight = tipPosition(lot(1200 - 32 - LOT_UNIT, 300, LOT_UNIT), TIP.width, TIP.height, 1200, 700);
    expect(atRight.left + TIP.width).toBe(1200 - 8);
  });

  it('never covers the lot or its labels, and stays in the map, for every lot of real layouts', () => {
    const sides = [8, 0, 3, 1, 12, 2, 0, 5].map(lotSide);
    for (const width of [480, 760, 1024, 1440]) {
      const layout = layoutLots(sides.map((side, id) => ({ id, side })), width);
      for (const place of layout.lots) {
        const at = tipPosition(place, TIP.width, TIP.height, width, layout.height);
        const card = { left: at.left, top: at.top, right: at.left + TIP.width, bottom: at.top + TIP.height };
        expect(overlaps(card, lotBox(place)), `lot ${String(place.id)} at width ${String(width)}`).toBe(false);
        expect(card.left).toBeGreaterThanOrEqual(8);
        expect(card.right).toBeLessThanOrEqual(width - 8);
        expect(card.top).toBeGreaterThanOrEqual(8);
      }
    }
  });
});
