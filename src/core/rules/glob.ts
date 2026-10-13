// The one glob matcher of core: rule include/exclude globs (ADR-030) and layer
// module segments (ADR-031). No RegExp and no backtracking: the pattern is
// read as a small automaton and the path is walked once, keeping the set of
// pattern positions still alive as a bit set, 32 positions per machine word.
// Each path character costs pattern length / 32 word operations, so matching
// is linear in the path for a bounded pattern, which validation guarantees
// with GLOB_MAX_LENGTH. Pure: no I/O.
//
// Unlike the RegExp `.*` it replaces, `**` also crosses a newline in a path;
// `*` already did, as `[^/]*`.

/** The longest include/exclude entry or layers module a rule may hold (ADR-030). */
export const GLOB_MAX_LENGTH = 1024;

// `*` is any run without `/`, `**` any run, and `**` followed by `/` is
// nothing, or any run ending in `/`.
type Kind = 'star' | 'globstar' | 'globstar-dir';
type Token = { kind: 'char'; char: string } | { kind: Kind };

/**
 * Two adjacent wildcards as one, or null when they must stay apart. Every
 * merge is an equivalence: `**` absorbs any wildcard next to it, and `**`+`/`
 * followed by `*` is any string (cut it at its last `/`). The only pair left
 * is `*` before `**`+`/`, so a run of wildcards is never longer than two.
 */
function merged(left: Kind, right: Kind): Kind | null {
  if (left === 'globstar' || right === 'globstar') return 'globstar';
  if (left === right) return left;
  if (left === 'globstar-dir') return 'globstar';
  return null;
}

function tokens(pattern: string): Token[] {
  const out: Token[] = [];
  const push = (kind: Kind): void => {
    let current = kind;
    for (;;) {
      const top = out[out.length - 1];
      if (top === undefined || top.kind === 'char') break;
      const both = merged(top.kind, current);
      if (both === null) break;
      out.pop();
      current = both;
    }
    out.push({ kind: current });
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? '';
    if (char !== '*') {
      out.push({ kind: 'char', char });
    } else if (pattern[i + 1] !== '*') {
      push('star');
    } else if (pattern[i + 2] === '/') {
      push('globstar-dir');
      i += 2;
    } else {
      push('globstar');
      i += 1;
    }
  }
  return out;
}

/** A compiled pattern: one bit per token position, bit `size` is a full match. */
interface Program {
  size: number;
  words: number;
  chars: Map<string, Uint32Array>;
  star: Uint32Array;
  globstar: Uint32Array;
  dir: Uint32Array;
  wildcard: Uint32Array;
}

function compile(pattern: string): Program {
  const list = tokens(pattern);
  const size = list.length;
  const words = (size >>> 5) + 1;
  const mask = (): Uint32Array => new Uint32Array(words);
  const program: Program = { size, words, chars: new Map(), star: mask(), globstar: mask(), dir: mask(), wildcard: mask() };
  for (const [i, token] of list.entries()) {
    const word = i >>> 5;
    const bit = 1 << (i & 31);
    let target: Uint32Array;
    if (token.kind === 'char') {
      target = program.chars.get(token.char) ?? mask();
      program.chars.set(token.char, target);
    } else {
      target = token.kind === 'star' ? program.star : token.kind === 'globstar' ? program.globstar : program.dir;
      program.wildcard[word] = (program.wildcard[word] ?? 0) | bit;
    }
    target[word] = (target[word] ?? 0) | bit;
  }
  return program;
}

/** Adds to `states` every position a wildcard can skip to without reading. Runs are at most two long. */
function close(program: Program, states: Uint32Array): void {
  for (let pass = 0; pass < 2; pass++) {
    let carry = 0;
    for (let w = 0; w < program.words; w++) {
      const skip = (states[w] ?? 0) & (program.wildcard[w] ?? 0);
      states[w] = (states[w] ?? 0) | (skip << 1) | carry;
      carry = skip >>> 31;
    }
  }
}

function run(program: Program, path: string): boolean {
  const { size, words } = program;
  // at: the path read so far can be followed by the tokens from this position.
  // inDir: a `**`+`/` at this position has started reading and still owes its `/`.
  let at = new Uint32Array(words);
  let inDir = new Uint32Array(words);
  let nextAt = new Uint32Array(words);
  let nextInDir = new Uint32Array(words);
  at[0] = 1;
  close(program, at);
  // UTF-16 units, like the pattern's tokens: a character outside the BMP is two literals on both sides.
  for (let p = 0; p < path.length; p++) {
    const char = path[p] ?? '';
    const slash = char === '/';
    const chars = program.chars.get(char);
    let carry = 0;
    let alive = 0;
    for (let w = 0; w < words; w++) {
      const now = at[w] ?? 0;
      const owing = (inDir[w] ?? 0) | (now & (program.dir[w] ?? 0));
      const advance = (chars === undefined ? 0 : now & (chars[w] ?? 0)) | (slash ? owing : 0);
      const stay = (now & (program.globstar[w] ?? 0)) | (slash ? 0 : now & (program.star[w] ?? 0));
      const next = (advance << 1) | carry | stay;
      carry = advance >>> 31;
      nextAt[w] = next;
      nextInDir[w] = owing;
      alive |= next | owing;
    }
    if (alive === 0) return false;
    close(program, nextAt);
    [at, nextAt] = [nextAt, at];
    [inDir, nextInDir] = [nextInDir, inDir];
  }
  return ((at[size >>> 5] ?? 0) & (1 << (size & 31))) !== 0;
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
  const program = compile(pattern);
  return (path) => run(program, path);
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
