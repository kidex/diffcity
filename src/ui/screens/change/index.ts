// The change screen (SPEC.md section 6): the city and the reading panel. It
// renders from a Report alone and never imports src/ui/data (ADR-002,
// ADR-022): the SPA passes `live`, the HTML export does not.

import type { Report } from '../../../core/report/types.js';
import { renderPlaceholder } from '../placeholder.js';

/** Live updates for an open change; missing in the export. */
export interface ChangeLive {
  /** Calls `listener` when a new snapshot of this change exists; returns the unsubscribe function. */
  onSnapshot(listener: () => void): () => void;
}

export interface ChangeScreenOptions {
  /** Null while the first snapshot is being computed. */
  report: Report | null;
  live?: ChangeLive;
}

export function mountChange(element: HTMLElement, options: ChangeScreenOptions): () => void {
  const unmount = renderPlaceholder(element, 'change', 'What the agent built', 'Change view arrives in phase 3.');
  const stopLive = options.live?.onSnapshot(() => undefined);
  return () => {
    stopLive?.();
    unmount();
  };
}
