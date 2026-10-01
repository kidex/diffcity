export const MS_PER_SECOND = 1000;

export function formatDuration(ms: number): string;
export function formatDuration(ms: bigint): string;
export function formatDuration(start: Date, end: Date): string;
export function formatDuration(a: number | bigint | Date, b?: Date): string {
  const ms = typeof a === 'number' || typeof a === 'bigint' ? Number(a) : (b?.getTime() ?? 0) - a.getTime();
  return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}
