// Reading the spec (SPEC.md 5.5, ADR-035): `.diffcity/spec.md` from the after
// state through the guarded git layer (the head tree for a commit, the
// working tree, confined to the repo, for a dirty change), or the file
// `diffcity diff --spec <file>` names, from disk. Either way at most
// MAX_SPEC_BYTES; a larger spec counts as absent, with a notice. The text is
// data: nothing in it is executed or followed.

import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readAfterBytes, sizeAfter, type ResolvedChange } from '../git/index.js';
import { MAX_SPEC_BYTES, SPEC_PATH } from './scope.js';

/** The spec of a build, as read. */
export type SpecSource =
  | { kind: 'absent' }
  | { kind: 'too-large' }
  /** `path` is repo-relative for `.diffcity/spec.md`; absolute for a `--spec` file. */
  | { kind: 'text'; text: string; path: string };

/** `.diffcity/spec.md` of the change's after state. */
export async function readRepoSpec(change: ResolvedChange): Promise<SpecSource> {
  const size = await sizeAfter(change, SPEC_PATH);
  if (size === null) return { kind: 'absent' };
  if (size > MAX_SPEC_BYTES) return { kind: 'too-large' };
  const bytes = await readAfterBytes(change, SPEC_PATH);
  if (bytes === null) return { kind: 'absent' };
  // Grown between the size check and the read.
  if (bytes.length > MAX_SPEC_BYTES) return { kind: 'too-large' };
  return { kind: 'text', text: bytes.toString('utf8'), path: SPEC_PATH };
}

/**
 * The file `--spec <file>` names, resolved against `cwd`. Throws when it
 * cannot be read or is not a regular file: the user asked for it.
 */
export async function readSpecFile(file: string, cwd: string): Promise<SpecSource> {
  const path = resolve(cwd, file);
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${file} is not a file`);
    if (stats.size > MAX_SPEC_BYTES) return { kind: 'too-large' };
    // One byte over the limit tells a file that grew after the stat.
    const buffer = Buffer.alloc(MAX_SPEC_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_SPEC_BYTES) return { kind: 'too-large' };
    }
    return { kind: 'text', text: buffer.subarray(0, length).toString('utf8'), path };
  } finally {
    await handle.close();
  }
}

/**
 * The repo-relative path of the spec file, when it is inside the repo at
 * `root` (so it can be a touched file of the change); null otherwise.
 */
export async function specPathInRepo(source: Extract<SpecSource, { kind: 'text' }>, root: string): Promise<string | null> {
  if (!isAbsolute(source.path)) return source.path;
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([realpath(source.path), realpath(root)]);
  } catch {
    return null;
  }
  const inside = relative(realRoot, real);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return inside.split(sep).join('/');
}
