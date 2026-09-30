/**
 * Makes names unique by suffixing repeats in order: the first stays as is,
 * the second gets `~2`, the third `~3` (ADR-011: symbol ids `path#name~2`).
 */
export function withDuplicateSuffixes(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}~${String(count)}`;
  });
}
