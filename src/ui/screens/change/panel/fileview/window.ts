// Windowed rendering of the full diff (ADR-027): rows have a fixed height, so
// which ones are in the DOM is plain arithmetic on the scroll offset. Pure: no
// DOM, no three.js.

export interface ItemRange {
  /** First item in the DOM. */
  start: number;
  /** One past the last item in the DOM. */
  end: number;
}

/** The items to keep in the DOM for a viewport: the visible ones plus `overscan` on each side. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan: number): ItemRange {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, Math.max(first + 1, last) + overscan) };
}

/** The largest scroll offset: the content's height minus the viewport's. */
export const maxScroll = (total: number, rowHeight: number, viewport: number): number => Math.max(0, total * rowHeight - viewport);

/** The scroll offset that puts `item` `lead` rows below the top of the viewport, within the content. */
export function scrollToItem(item: number, rowHeight: number, viewport: number, total: number, lead: number): number {
  const wanted = (item - lead) * rowHeight;
  return Math.min(maxScroll(total, rowHeight, viewport), Math.max(0, wanted));
}

/**
 * The scroll offset that keeps the same content where it was after the items
 * changed: `anchorItem` is the item that was at the top, `offset` how far the
 * viewport's top was below its top edge.
 */
export const anchoredScroll = (anchorItem: number, offset: number, rowHeight: number): number => Math.max(0, anchorItem * rowHeight + offset);
