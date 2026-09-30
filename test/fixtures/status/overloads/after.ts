export function portion(size: number): number;
export function portion(size: string): number;
export function portion(size: bigint): number;
export function portion(size: number | string | bigint): number {
  return Number(size);
}
