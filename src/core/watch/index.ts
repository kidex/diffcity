// What the daemon's watchers watch and ignore (ADR-020).

export { gitIgnoreMatcher } from './git-paths.js';
export { ALWAYS_IGNORED_NAMES, countWatchedDirs, ignoreMatcher, listIgnored, parseIgnored } from './ignore.js';
export type { IgnoredSet } from './ignore.js';
