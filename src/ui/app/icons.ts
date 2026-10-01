// Inline SVG icons for the top bar. Colours come from CSS (currentColor and
// the .mark .fill rule), never from TypeScript.

import { svg } from '../shared/dom.js';

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' };

/** The diffcity mark from the mockup's top bar. */
export function brandMark(): SVGElement {
  return svg(
    'svg',
    { class: 'mark', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    svg('path', { d: 'M12 2 21 7v10l-9 5-9-5V7l9-5Z', ...STROKE }),
    svg('path', { d: 'M12 12 21 7M12 12v10M12 12 3 7', ...STROKE }),
    svg('path', { d: 'M12 12v5l4.5-2.5V9.5', class: 'fill' }),
  );
}

export function searchIcon(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    svg('circle', { cx: '11', cy: '11', r: '7', ...STROKE, 'stroke-width': '2' }),
    svg('path', { d: 'm16.5 16.5 4 4', ...STROKE, 'stroke-width': '2', 'stroke-linecap': 'round' }),
  );
}
