// User copy for the daemon's repo notes (`RepoSummary.notes`). The daemon
// decides when a note applies and sends `{ code, text }`; the UI words the
// codes it knows and shows the daemon's `text` for any other code.

import type { RepoNote } from '../../core/model/types.js';

/** The code of an untrusted repo with a diffcity.config.js (ADR-030, ADR-022). */
const CONFIG_NOT_TRUSTED = 'config-not-trusted';

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
export function noteCopy(note: RepoNote, repoPath: string): NoteCopy {
  if (note.code === CONFIG_NOT_TRUSTED) {
    return {
      text: 'This repo has a diffcity.config.js that isn’t loaded because the repo isn’t trusted. Defaults are used for the base and tier 1.',
      command: `diffcity trust ${shellArg(repoPath)}`,
    };
  }
  return { text: note.text, command: null };
}

/** The short form for an indicator's accessible name and tooltip: the text, then the command. */
export function noteSummary(note: RepoNote, repoPath: string): string {
  const copy = noteCopy(note, repoPath);
  return copy.command === null ? copy.text : `${copy.text} Run: ${copy.command}`;
}
