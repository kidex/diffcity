export function season(salt: number): number {
  return salt;
}

export function plate(name: string): string {
  return `plate ${name}`;
}

export function garnish(leaf: string): string {
  return leaf.toUpperCase();
}
