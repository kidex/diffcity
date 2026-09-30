export function portion(size: number): number;
export function portion(size: string): number;
export function portion(size: number | string): number {
  return Number(size);
}
