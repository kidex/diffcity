// Loads a call-graph fixture (a case directory under test/fixtures/path with a
// before and an after tree) as the input of buildCallGraph, with symbols and
// statuses from the real comparison.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFileWithFingerprints } from '../../src/core/diff/status.js';
import type { CallGraphInput, GraphFile } from '../../src/core/path/graph.js';

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

/** Symbol id of `name` in `path`, as the report ids it. */
export const id = (path: string, name: string): string => `${path}#${name}`;
