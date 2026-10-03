// The diff job (ADR-027): what the daemon hands to a worker thread, and the
// computation the worker runs. Plain data in, a JSON string out, so a result of
// several MB crosses postMessage as one string and is sent as it is.

import type { FileFingerprint } from '../model/types.js';
import { languageForPath } from '../parse/language.js';
import type { Report } from '../report/types.js';
import { createDiffGit } from './diff-git.js';
import { computeFileDiff, type FileDiffRequest } from './file-diff.js';

export interface DiffJob {
  /** The repo root for a commit, the change's working tree when the snapshot is dirty. */
  repoDir: string;
  snapshotId: number;
  head: string;
  mergeBase: string | null;
  worktree: boolean;
  /** A key of the snapshot's fingerprints.files; the route checked it. */
  path: string;
  fingerprint: FileFingerprint;
  /** A key of the snapshot's fingerprints.symbols, starting with `path#`; the route checked it. */
  focus?: string | undefined;
  /** The snapshot's serialized Report, for the file's language and symbol ranges. */
  reportJson: string;
}

/** `File.language` of a file diffcity does not parse (src/core/report/build.ts). */
const OTHER_LANGUAGE = 'other';

/** The language and symbols of `path` in the Report; the path's own language and no symbols when it is not there. */
function fileOf(reportJson: string, path: string): Pick<FileDiffRequest, 'language' | 'symbols'> {
  const report = JSON.parse(reportJson) as Report;
  for (const pkg of report.packages) {
    for (const file of pkg.files) {
      if (file.id !== path) continue;
      return { language: file.language, symbols: file.symbols.map((symbol) => ({ id: symbol.id, status: symbol.status, range: symbol.range })) };
    }
  }
  return { language: languageForPath(path) ?? OTHER_LANGUAGE, symbols: [] };
}

/** Computes the FileDiff of a job and returns it serialized. */
export async function runDiffJob(job: DiffJob): Promise<string> {
  const request: FileDiffRequest = {
    snapshotId: job.snapshotId,
    head: job.head,
    mergeBase: job.mergeBase,
    worktree: job.worktree,
    path: job.path,
    fingerprint: job.fingerprint,
    focus: job.focus,
    ...fileOf(job.reportJson, job.path),
  };
  return JSON.stringify(await computeFileDiff(request, createDiffGit(job.repoDir)));
}
