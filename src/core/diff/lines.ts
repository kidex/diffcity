// A line diff over two in-memory texts (Myers, O(ND)), for the excerpts the
// execution path shows per step (ADR-034). The file view diffs whole files
// with git (file-diff.ts); a step only needs the lines of one symbol, which
// the report already holds in memory, so no git process is spawned per step.
// Pure and deterministic: deletions come before insertions in a changed run.

export interface LineOp {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

/** Above this many edits the middle is shown as removed then added, without alignment. */
export const MAX_LINE_EDITS = 2000;

/**
 * The edit script from `before` to `after`, line by line: every line of both
 * sides once, `ctx` for a line kept, `del` for a line only in before, `add`
 * for a line only in after.
 */
export function diffLines(before: readonly string[], after: readonly string[], maxEdits = MAX_LINE_EDITS): LineOp[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const head: LineOp[] = before.slice(0, prefix).map((text) => ({ kind: 'ctx', text }));
  const tail: LineOp[] = before.slice(before.length - suffix).map((text) => ({ kind: 'ctx', text }));
  return [...head, ...middle(a, b, maxEdits), ...tail];
}

function middle(a: readonly string[], b: readonly string[], maxEdits: number): LineOp[] {
  const n = a.length;
  const m = b.length;
  const removedThenAdded = (): LineOp[] => [
    ...a.map((text): LineOp => ({ kind: 'del', text })),
    ...b.map((text): LineOp => ({ kind: 'add', text })),
  ];
  if (n === 0 || m === 0) return removedThenAdded();

  const limit = Math.min(n + m, Math.max(0, maxEdits));
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found === -1; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found === -1) return removedThenAdded();

  const ops: LineOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const state = trace[d] ?? v;
    const k = x - y;
    const down = k === -d || (k !== d && (state[k - 1 + offset] ?? 0) < (state[k + 1 + offset] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (state[prevK + offset] ?? 0);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'ctx', text: a[x - 1] ?? '' });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: 'add', text: b[prevY] ?? '' });
      else ops.push({ kind: 'del', text: a[prevX] ?? '' });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
