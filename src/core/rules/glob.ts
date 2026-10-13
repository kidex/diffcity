// The one glob matcher of core: rule include/exclude globs (ADR-030) and layer
// module segments (ADR-031). No RegExp and no backtracking: the pattern is
// read as a small automaton and the path is walked once, keeping the set of
// pattern positions still alive, so the cost is at most path length times
// pattern length whatever the stars. Pure: no I/O.

// `*` is any run without `/`, `**` any run, and `**` followed by `/` is
// nothing, or any run ending in `/`.
type Token = { kind: 'char'; char: string } | { kind: 'star' } | { kind: 'globstar' } | { kind: 'globstar-dir' };

function tokens(pattern: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? '';
    if (char !== '*') {
      out.push({ kind: 'char', char });
    } else if (pattern[i + 1] !== '*') {
      out.push({ kind: 'star' });
    } else if (pattern[i + 2] === '/') {
      out.push({ kind: 'globstar-dir' });
      i += 2;
    } else {
      out.push({ kind: 'globstar' });
      i += 1;
    }
  }
  return out;
}

/**
 * Whether a whole path matches a glob where `*` stands for any run of
 * characters other than `/`, `**` for any run at all, and `**` followed by `/`
 * also for no directory at all, so `src/**` + `/*.ts` matches `src/a.ts`.
 * Every other character is literal. Case-sensitive.
 */
export function globMatch(pattern: string, path: string): boolean {
  return globMatcher(pattern)(path);
}

/** globMatch with the pattern compiled once, for testing many paths. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const program = tokens(pattern);
  const size = program.length;
  return (path) => run(program, size, path);
}

function run(program: readonly Token[], size: number, path: string): boolean {
  // at[i]: the path read so far can be followed by tokens i.., i === size is a full match.
  // inDir[i]: token i is a `**` + `/` that has started consuming and still owes its `/`.
  let at = new Uint8Array(size + 1);
  let inDir = new Uint8Array(size + 1);
  let nextAt = new Uint8Array(size + 1);
  let nextInDir = new Uint8Array(size + 1);
  const close = (states: Uint8Array): void => {
    for (let i = 0; i < size; i++) {
      if (states[i] === 1 && program[i]?.kind !== 'char') states[i + 1] = 1;
    }
  };
  at[0] = 1;
  close(at);
  for (let p = 0; p < path.length; p++) {
    const char = path[p];
    const slash = char === '/';
    nextAt.fill(0);
    nextInDir.fill(0);
    let alive = false;
    for (let i = 0; i < size; i++) {
      const token = program[i];
      if (token === undefined) continue;
      if (at[i] === 1) {
        if (token.kind === 'char') {
          if (token.char === char) nextAt[i + 1] = 1;
        } else if (token.kind === 'star') {
          if (!slash) nextAt[i] = 1;
        } else if (token.kind === 'globstar') {
          nextAt[i] = 1;
        } else {
          nextInDir[i] = 1;
          if (slash) nextAt[i + 1] = 1;
        }
      }
      if (inDir[i] === 1) {
        nextInDir[i] = 1;
        if (slash) nextAt[i + 1] = 1;
      }
    }
    close(nextAt);
    for (let i = 0; i <= size && !alive; i++) alive = nextAt[i] === 1 || nextInDir[i] === 1;
    if (!alive) return false;
    [at, nextAt] = [nextAt, at];
    [inDir, nextInDir] = [nextInDir, inDir];
  }
  return at[size] === 1;
}

/**
 * Whether one path segment matches a segment pattern where `*` stands for any
 * run of characters other than `/`. A value or pattern with a `/` never
 * matches: neither is a single segment.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  return segmentMatcher(pattern)(value);
}

/** wildcardMatch with the segment pattern compiled once. */
export function segmentMatcher(pattern: string): (value: string) => boolean {
  if (pattern.includes('/')) return () => false;
  const match = globMatcher(pattern);
  return (value) => !value.includes('/') && match(value);
}
