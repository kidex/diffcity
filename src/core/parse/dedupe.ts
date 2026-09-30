/**
 * Makes names unique by suffixing repeats in order: the first stays as is,
 * the second gets `~2`, the third `~3` (ADR-011: symbol ids `path#name~2`).
 * A suffix already used by a literal name in the input is skipped, so
 * `x, x, x~2` gives `x, x~3, x~2`.
 */
export function withDuplicateSuffixes(names: readonly string[]): string[] {
  const reserved = new Set(names);
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return names.map((name) => {
    let unique = name;
    if (used.has(name)) {
      let n = nextSuffix.get(name) ?? 2;
      while (reserved.has(`${name}~${String(n)}`) || used.has(`${name}~${String(n)}`)) n += 1;
      unique = `${name}~${String(n)}`;
      nextSuffix.set(name, n + 1);
    }
    used.add(unique);
    return unique;
  });
}
