export { GitError } from './exec.js';
export { defaultRunner } from '../exec/gh.js';
export type { CommandRunner, GitErrorCode, RunOptions } from './exec.js';
export { GH_TIMEOUT_MS, NO_BASE_MESSAGE, resolveBase } from './base.js';
export type { BaseSource, ResolveBaseOptions, ResolvedBase } from './base.js';
export { findRepoRoot, resolveChange } from './change.js';
export type { ResolveChangeOptions, ResolvedChange } from './change.js';
export {
  changedFiles,
  countLines,
  hashAfter,
  hashBefore,
  listHeadFiles,
  looksBinary,
  measureAfter,
  parseDiffOutput,
  readAfter,
  readAfterBatch,
  readAfterBytes,
  readBefore,
  readBeforeBytes,
  sizeAfter,
  sizeAfterBatch,
  sizeBefore,
} from './files.js';
export type { ChangeType, ChangedFile } from './files.js';
export { computeMeta, countCommits } from './meta.js';
export { OWN_DIR, OWN_DIRS, OWN_FILES, isOwnFile } from './own-files.js';
