export { GitError, defaultRunner } from './exec.js';
export type { CommandRunner, GitErrorCode, RunOptions } from './exec.js';
export { GH_TIMEOUT_MS, NO_BASE_MESSAGE, resolveBase } from './base.js';
export type { BaseSource, ResolveBaseOptions, ResolvedBase } from './base.js';
export { findRepoRoot, resolveChange } from './change.js';
export type { ResolveChangeOptions, ResolvedChange } from './change.js';
export {
  changedFiles,
  listHeadFiles,
  looksBinary,
  parseDiffOutput,
  readAfter,
  readAfterBatch,
  readAfterBytes,
  readBefore,
  readBeforeBytes,
} from './files.js';
export type { ChangeType, ChangedFile } from './files.js';
export { computeMeta, countCommits } from './meta.js';
