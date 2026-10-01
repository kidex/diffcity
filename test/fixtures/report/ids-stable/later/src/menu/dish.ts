export function season(salt: number): number {
  return salt;
}

export function plate(name: string, size: number): string {
  return `plate ${name} ${String(size)}`;
}

export function garnish(leaf: string): string {
  return leaf.toUpperCase();
}
