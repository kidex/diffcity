// The words of the full diff's states. Pure; the daemon's `reason` and the
// sizes are shown as given, never interpreted.

import type { FileDiff } from '../../../../../core/model/types.js';

export const LOADING = 'Loading the full diff…';
export const LOAD_FAILED = 'The full diff could not be loaded';
export const STALE_BANNER = 'This file changed after the snapshot; a new one is being computed';
export const BINARY = 'Binary file: its contents are not shown';
export const TOO_LARGE = 'This file is too large to show here';
export const UNAVAILABLE = 'The diff is not available';
export const UNCHANGED = 'This file is unchanged in this change';
export const NO_LINES = 'No lines to show';

/** "512 B", "1.5 KiB", "2.0 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** "before 1.0 KiB, after 2.0 KiB", with "new file" / "deleted" for a missing side. */
export function sizesLine(sizes: FileDiff['sizes']): string {
  const before = sizes.before === null ? 'new file' : `before ${formatBytes(sizes.before)}`;
  const after = sizes.after === null ? 'deleted' : `after ${formatBytes(sizes.after)}`;
  return `${before}, ${after}`;
}

/** "+12 −3 lines". */
export const statsLine = (stats: FileDiff['stats']): string => `+${String(stats.added)} −${String(stats.removed)} lines`;
