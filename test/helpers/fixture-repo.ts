// Temporary git repos built from a fixture directory with `before/`, `after/`
// and optional further stages (`later/`, ...). Each stage directory is the
// complete tree of that state: files missing from a stage are deleted.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo, type FileTree, type TempRepo } from './repo.js';

const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`. */
export function readTree(dir: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else if (entry.isFile()) tree[childRel] = readFileSync(join(abs, entry.name), 'utf8');
    }
  };
  walk(dir, '');
  return tree;
}

/** A file of the fixture itself (outside its stages), e.g. `spec.md`. */
export function fixtureFile(name: string, file: string): string {
  return readFileSync(join(fixturesRoot, name, file), 'utf8');
}

export function stageTree(name: string, stage: string): Record<string, string> {
  return readTree(join(fixturesRoot, name, stage));
}

export interface FixtureRepo {
  repo: TempRepo;
  /** Moves the repo's after state to `stage`: applies it and commits it, or leaves it in the working tree. */
  apply(stage: string, options?: { commit?: boolean }): Promise<string | null>;
}

export interface FixtureRepoOptions {
  /** Commit the after state on the feature branch; otherwise leave it uncommitted. Default true. */
  commit?: boolean;
  /** Extra files added to every stage (e.g. `.diffcity/spec.md`). */
  extra?: Record<string, string>;
  /** Feature branch holding the after state. Default `feature/work`. */
  branch?: string;
}

/**
 * Commits `before/` on `main`, checks out a feature branch and applies `after/`.
 */
export async function repoFromFixture(name: string, options: FixtureRepoOptions = {}): Promise<FixtureRepo> {
  const extra = options.extra ?? {};
  let current: Record<string, string> = { ...stageTree(name, 'before'), ...extra };
  const repo = await createRepo({ files: current, message: 'before' });

  async function apply(stage: string, applyOptions: { commit?: boolean } = {}): Promise<string | null> {
    const next: Record<string, string> = { ...stageTree(name, stage), ...extra };
    const tree: FileTree = { ...next };
    for (const path of Object.keys(current)) if (!(path in next)) tree[path] = null;
    current = next;
    if (applyOptions.commit ?? true) return repo.commit(stage, tree);
    await repo.write(tree);
    return null;
  }

  try {
    await repo.branch(options.branch ?? 'feature/work');
    await apply('after', { commit: options.commit ?? true });
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
  return { repo, apply };
}
