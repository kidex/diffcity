// Fleet (SPEC.md section 6): every repo as a lot, then the repo list with
// counters. The map and the list are built on this mount point.

import { renderPlaceholder } from '../placeholder.js';

export function mountFleet(element: HTMLElement): () => void {
  return renderPlaceholder(element, 'fleet', 'Your repos', 'Every repo you work in appears here, with its changes and its last audit.');
}
