export function walk(depth: number): number {
  return depth <= 0 ? 0 : 1 + walk(depth - 1);
}

export function ping(n: number): number {
  return n <= 0 ? 0 : pong(n - 1);
}

export function pong(n: number): number {
  return n <= 0 ? 1 : ping(n - 1);
}
