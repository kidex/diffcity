// User copy for the daemon's repo notes (`RepoSummary.notes`). The daemon
// decides when a note applies; the UI only words the notes it knows and shows
// any other note as the daemon wrote it.

/**
 * The note the daemon sends for an untrusted repo with a diffcity.config.js
 * (ADR-030). The same text as `CONFIG_NOT_TRUSTED_NOTE` in src/core/settings,
 * which the UI bundle cannot import (it pulls in node:fs); a unit test keeps
 * the two equal.
 */
export const CONFIG_NOT_TRUSTED = 'config not loaded: repo not trusted (run diffcity trust)';

export interface NoteCopy {
  /** The note as the user reads it. */
  text: string;
  /** A command that resolves the note, shown as copyable code; null when there is none. */
  command: string | null;
}

/** Quotes a path for a POSIX shell when it needs it, so the copied command runs as is. */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The copy of one note of the repo at `repoPath`. */
export function noteCopy(note: string, repoPath: string): NoteCopy {
  if (note === CONFIG_NOT_TRUSTED) {
    return {
      text: 'This repo has a diffcity.config.js that isn’t loaded because the repo isn’t trusted. Defaults are used for the base and tier 1.',
      command: `diffcity trust ${shellArg(repoPath)}`,
    };
  }
  return { text: note, command: null };
}

/** The short form for an indicator's accessible name and tooltip: the text, then the command. */
export function noteSummary(note: string, repoPath: string): string {
  const copy = noteCopy(note, repoPath);
  return copy.command === null ? copy.text : `${copy.text} Run: ${copy.command}`;
}
