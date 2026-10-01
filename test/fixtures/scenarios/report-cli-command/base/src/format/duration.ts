export const MS_PER_SECOND = 1000;

export function formatDuration(ms: number): string;
export function formatDuration(start: Date, end: Date): string;
export function formatDuration(a: number | Date, b?: Date): string {
  const ms = typeof a === 'number' ? a : (b?.getTime() ?? 0) - a.getTime();
  return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}
