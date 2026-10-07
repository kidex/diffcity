// Loads a path fixture (a case directory under test/fixtures/path with a
// before and an after tree) as the input of buildCallGraph or of
// buildExecutionPath, with symbols and statuses from the real comparison.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFileWithFingerprints } from '../../src/core/diff/status.js';
import type { CallGraphInput, GraphFile } from '../../src/core/path/graph.js';
import type { ExecutionPathInput } from '../../src/core/path/order.js';
import { preparePathFile, prepareUntouchedFile, type PathFile } from '../../src/core/path/prepare.js';
import { languageForPath } from '../../src/core/parse/language.js';

const fixtures = fileURLToPath(new URL('../fixtures/path/', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();
}

function readSide(root: string): Map<string, string> {
  try {
    return new Map(walk(root).map((path) => [path, readFileSync(join(root, path), 'utf8')]));
  } catch {
    return new Map();
  }
}

/** Compares the before tree with the after tree of a fixture directory, file by file. */
export async function fixtureChange(name: string, overrides: { log?: (message: string) => void } = {}): Promise<CallGraphInput> {
  const root = join(fixtures, name);
  const before = readSide(join(root, 'before'));
  const after = readSide(join(root, 'after'));
  const files: GraphFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path) ?? null;
    const a = after.get(path) ?? null;
    const change = b === null ? 'add' : a === null ? 'del' : 'mod';
    const { status, symbols } = await compareFileWithFingerprints({ path, change, binary: false, before: b, after: a });
    files.push({ path, status, after: a, symbols });
  }
  return { files, tsconfig: after.get('tsconfig.json') ?? null, ...overrides };
}

/**
 * The input of buildExecutionPath for a fixture, as buildReport makes it: every
 * touched code file (status other than `same`) prepared from both versions,
 * the untouched ones that register entry points, the root tsconfig.json and
 * package.json of the after tree.
 */
export async function fixturePath(name: string, overrides: { log?: (message: string) => void } = {}): Promise<ExecutionPathInput> {
  const root = join(fixtures, name);
  const before = readSide(join(root, 'before'));
  const after = readSide(join(root, 'after'));
  const files: PathFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (languageForPath(path) === null) continue;
    const b = before.get(path) ?? null;
    const a = after.get(path) ?? null;
    const change = b === null ? 'add' : a === null ? 'del' : 'mod';
    const { status, symbols, ranges } = await compareFileWithFingerprints({ path, change, binary: false, before: b, after: a });
    if (status === 'same') {
      const untouched = a === null ? null : await prepareUntouchedFile(path, a, symbols);
      if (untouched !== null) files.push(untouched);
      continue;
    }
    files.push(await preparePathFile({ path, status, before: b, after: a, symbols, ranges }));
  }
  return { files, tsconfig: after.get('tsconfig.json') ?? null, packageJson: after.get('package.json') ?? null, ...overrides };
}

/** Symbol id of `name` in `path`, as the report ids it. */
export const id = (path: string, name: string): string => `${path}#${name}`;
