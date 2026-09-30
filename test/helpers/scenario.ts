// Golden change scenarios (ADR-014): test/fixtures/scenarios/<name>/ holds
// `base/` (the initial tree), `steps.json` (what happens on top of it) and
// `expected.json` (the golden Report). The repo is built here, in a temp
// directory named after the invented repo, so meta.repo is stable.
//
// Order of operations:
//   1. `base/` is committed on the `base` branch;
//   2. `branch` is created from it and each entry of `commits` is applied and committed;
//   3. each entry of `baseCommits` is committed on the base branch after the
//      branch forked (so the merge-base, not the base tip, is "before");
//   4. `branch` is checked out again and `uncommitted` is applied without committing;
//      its `stage` paths are staged, everything else stays unstaged or untracked.
//
// One change (a commit or the uncommitted state) is applied as: renames first
// (the file moves with its content), then deletions, then the files of the
// overlay directory, which overwrite or add. Overlay directories are paths
// relative to the scenario directory.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTree } from './fixture-repo.js';
import { createRepo, type FileTree, type TempRepo } from './repo.js';

export const scenariosRoot = fileURLToPath(new URL('../fixtures/scenarios/', import.meta.url));

export interface ScenarioChange {
  /** Overlay directory, relative to the scenario directory. */
  files?: string;
  /** Paths removed from the tree. */
  delete?: string[];
  /** Old path to new path; the file keeps its content unless the overlay rewrites it. */
  rename?: Record<string, string>;
}

export interface ScenarioCommit extends ScenarioChange {
  message: string;
}

export interface ScenarioUncommitted extends ScenarioChange {
  /** Paths staged with `git add` after the change is applied; the rest stays unstaged or untracked. */
  stage?: string[];
}

export interface ScenarioSteps {
  /** Invented repo name: the temp working tree is named after it and it becomes meta.repo. */
  repo: string;
  /** Branch holding `base/`. */
  base: string;
  /** Feature branch the change lives on. */
  branch: string;
  /** ISO 8601 date-time passed as DIFFCITY_NOW; it becomes meta.generatedAt. */
  now: string;
  commits: ScenarioCommit[];
  baseCommits?: ScenarioCommit[];
  uncommitted?: ScenarioUncommitted;
}

export interface Scenario {
  name: string;
  dir: string;
  steps: ScenarioSteps;
  expectedPath: string;
}

export interface BuiltScenario {
  repo: TempRepo;
}

const STEP_KEYS = new Set(['repo', 'base', 'branch', 'now', 'commits', 'baseCommits', 'uncommitted']);
const CHANGE_KEYS = new Set(['files', 'delete', 'rename', 'message', 'stage']);

function fail(name: string, problem: string): never {
  throw new Error(`scenario ${name}: steps.json ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function checkChange(name: string, where: string, value: unknown, needsMessage: boolean): void {
  if (!isRecord(value)) fail(name, `${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!CHANGE_KEYS.has(key)) fail(name, `${where} has an unknown field "${key}"`);
  }
  if (needsMessage && typeof value.message !== 'string') fail(name, `${where}.message must be a string`);
  if (!needsMessage && value.message !== undefined) fail(name, `${where} must not have a message`);
  if (needsMessage && value.stage !== undefined) fail(name, `${where}.stage is only for uncommitted`);
  if (value.files !== undefined && typeof value.files !== 'string') fail(name, `${where}.files must be a string`);
  if (value.delete !== undefined && !isStringArray(value.delete)) fail(name, `${where}.delete must be a string array`);
  if (value.stage !== undefined && !isStringArray(value.stage)) fail(name, `${where}.stage must be a string array`);
  if (value.rename !== undefined) {
    if (!isRecord(value.rename) || !Object.values(value.rename).every((to) => typeof to === 'string')) {
      fail(name, `${where}.rename must map old paths to new paths`);
    }
  }
}

/** Validates the parsed steps.json of scenario `name`. */
export function parseSteps(name: string, value: unknown): ScenarioSteps {
  if (!isRecord(value)) fail(name, 'must be an object');
  for (const key of Object.keys(value)) if (!STEP_KEYS.has(key)) fail(name, `has an unknown field "${key}"`);
  for (const key of ['repo', 'base', 'branch', 'now'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') fail(name, `field "${key}" must be a non-empty string`);
  }
  if (!Array.isArray(value.commits)) fail(name, 'field "commits" must be an array');
  value.commits.forEach((commit, i) => {
    checkChange(name, `commits[${String(i)}]`, commit, true);
  });
  if (value.baseCommits !== undefined) {
    if (!Array.isArray(value.baseCommits)) fail(name, 'field "baseCommits" must be an array');
    value.baseCommits.forEach((commit, i) => {
      checkChange(name, `baseCommits[${String(i)}]`, commit, true);
    });
  }
  if (value.uncommitted !== undefined) checkChange(name, 'uncommitted', value.uncommitted, false);
  // Shape checked field by field above.
  return value as unknown as ScenarioSteps;
}

/** Every scenario directory, sorted by name. */
export function listScenarios(): Scenario[] {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(scenariosRoot, name);
      const steps = parseSteps(name, JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')));
      return { name, dir, steps, expectedPath: join(dir, 'expected.json') };
    });
}

async function applyChange(repo: TempRepo, scenarioDir: string, change: ScenarioChange): Promise<void> {
  const tree: FileTree = {};
  for (const [from, to] of Object.entries(change.rename ?? {})) {
    tree[to] = await readFile(join(repo.dir, from), 'utf8');
    tree[from] = null;
  }
  for (const path of change.delete ?? []) {
    if (!existsSync(join(repo.dir, path))) throw new Error(`cannot delete a missing file: ${path}`);
    tree[path] = null;
  }
  if (change.files !== undefined) Object.assign(tree, readTree(join(scenarioDir, change.files)));
  await repo.write(tree);
}

/** Builds the scenario's repo in a fresh temp directory named after `steps.repo`. */
export async function buildScenario(scenario: Scenario): Promise<BuiltScenario> {
  const { steps, dir } = scenario;
  const repo = await createRepo({
    name: steps.repo,
    initialBranch: steps.base,
    files: readTree(join(dir, 'base')),
    message: 'initial',
  });
  try {
    await repo.branch(steps.branch);
    for (const commit of steps.commits) {
      await applyChange(repo, dir, commit);
      await repo.commit(commit.message);
    }
    if (steps.baseCommits !== undefined && steps.baseCommits.length > 0) {
      await repo.checkout(steps.base);
      for (const commit of steps.baseCommits) {
        await applyChange(repo, dir, commit);
        await repo.commit(commit.message);
      }
      await repo.checkout(steps.branch);
    }
    if (steps.uncommitted !== undefined) {
      await applyChange(repo, dir, steps.uncommitted);
      const stage = steps.uncommitted.stage ?? [];
      if (stage.length > 0) await repo.git('add', '--', ...stage);
    }
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
  return { repo };
}
