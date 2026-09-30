export function portion(weight: number, slices: number): number {
  return weight / slices;
}

export function label(name: string): string {
  return name.trim();
}
