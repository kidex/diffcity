// The modules of a layers rule (ADR-031). A module is an entry of a layer: a
// repo-relative directory prefix, or a simple glob where `*` stands for part
// of one path segment (`packages/*/src`); each directory a glob matches is its
// own module. A file belongs to the module with the longest matching prefix.
// Pure: no I/O.

/** One entry of `layers`, ready to match. */
export interface LayerModule {
  /** The entry, normalized: no leading `./`, no trailing `/`. */
  pattern: string;
  /** 0 is the top layer. */
  layer: number;
  /** One matcher per path segment. */
  segments: readonly ((segment: string) => boolean)[];
}

/** The module a file belongs to: the directory the entry matched, and the entry's layer. */
export interface ModuleOf {
  module: string;
  layer: number;
}

export type LayerModules = { ok: true; modules: LayerModule[] } | { ok: false; message: string };

/**
 * Whether one path segment matches a segment pattern where `*` stands for any
 * run of characters other than `/`. Linear, no RegExp: the head and tail
 * literals are checked in place, then each middle literal is found left to
 * right with indexOf; taking the leftmost match is always right when `*` is
 * the only wildcard.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (value.includes('/')) return false;
  const parts = pattern.split('*');
  if (parts.length === 1) return value === pattern;
  const head = parts[0] ?? '';
  const tail = parts[parts.length - 1] ?? '';
  if (value.length < head.length + tail.length || !value.startsWith(head) || !value.endsWith(tail)) return false;
  const end = value.length - tail.length;
  let at = head.length;
  for (const middle of parts.slice(1, -1)) {
    if (middle === '') continue;
    const found = value.indexOf(middle, at);
    if (found === -1 || found + middle.length > end) return false;
    at = found + middle.length;
  }
  return true;
}

function segmentMatcher(segment: string): (value: string) => boolean {
  return (value) => wildcardMatch(segment, value);
}

/** `entry` without a leading `./` and trailing `/`, or null when it is not a plain repo-relative path. */
function normalizeEntry(entry: string): string | null {
  let pattern = entry;
  while (pattern.startsWith('./')) pattern = pattern.slice(2);
  while (pattern.endsWith('/')) pattern = pattern.slice(0, -1);
  if (pattern === '' || pattern.includes('\\') || pattern.includes('**')) return null;
  const segments = pattern.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? pattern : null;
}

/** The literal text before the first `*` and after the last one. */
function ends(segment: string): { head: string; tail: string } {
  return { head: segment.slice(0, segment.indexOf('*')), tail: segment.slice(segment.lastIndexOf('*') + 1) };
}

/** Whether some directory name matches both segment patterns. */
function segmentsOverlap(a: string, b: string): boolean {
  const aGlob = a.includes('*');
  const bGlob = b.includes('*');
  if (!aGlob && !bGlob) return a === b;
  if (!aGlob) return segmentMatcher(b)(a);
  if (!bGlob) return segmentMatcher(a)(b);
  // Both have a star: the stars take up any middle, so only the literal ends can conflict.
  const x = ends(a);
  const y = ends(b);
  return (x.head.startsWith(y.head) || y.head.startsWith(x.head)) && (x.tail.endsWith(y.tail) || y.tail.endsWith(x.tail));
}

/**
 * Two entries of the same depth that can match the same directory would put
 * one module in two places. Entries of different depths are nested: a file's
 * matches are all prefixes of its path, and the longest one wins.
 */
function overlap(a: string, b: string): boolean {
  const x = a.split('/');
  const y = b.split('/');
  return x.length === y.length && x.every((segment, i) => segmentsOverlap(segment, y[i] ?? ''));
}

/**
 * The modules of a `layers` value (already checked to be a non-empty array of
 * non-empty arrays of non-empty strings), or the first config error: an entry
 * that is not a repo-relative directory or simple glob, an entry listed twice,
 * or two entries that overlap without being nested.
 */
export function layerModules(layers: readonly (readonly string[])[]): LayerModules {
  const modules: LayerModule[] = [];
  for (const [layer, entries] of layers.entries()) {
    for (const entry of entries) {
      const pattern = normalizeEntry(entry);
      if (pattern === null) {
        return { ok: false, message: `module "${entry}" must be a repo-relative directory, or a glob with "*" inside path segments` };
      }
      for (const other of modules) {
        if (other.pattern === pattern) return { ok: false, message: `module "${pattern}" is listed twice` };
        if (overlap(other.pattern, pattern)) return { ok: false, message: `modules "${other.pattern}" and "${pattern}" overlap and are not nested` };
      }
      modules.push({ pattern, layer, segments: pattern.split('/').map(segmentMatcher) });
    }
  }
  return { ok: true, modules };
}

/**
 * The module of a repo-relative file path, or null when no entry matches it
 * (the file is outside the rule). An entry matches a file inside the
 * directory it names (or the file it names); the longest match wins.
 */
export function moduleOf(modules: readonly LayerModule[], path: string): ModuleOf | null {
  const parts = path.split('/');
  let best: (ModuleOf & { depth: number }) | null = null;
  for (const entry of modules) {
    const depth = entry.segments.length;
    if (depth > parts.length || (best !== null && depth <= best.depth)) continue;
    if (!entry.segments.every((matches, i) => matches(parts[i] ?? ''))) continue;
    best = { module: parts.slice(0, depth).join('/'), layer: entry.layer, depth };
  }
  return best === null ? null : { module: best.module, layer: best.layer };
}
