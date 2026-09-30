export function weighFlour(grams: number): number {
  return Math.round(grams);
}

export function siftFlour(grams: number): number {
  return grams * 0.98;
}
