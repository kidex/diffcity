// The layers rule (ADR-031) over a fixture of test/fixtures/rules/layers/,
// in process and without git: `before/` and `after/` are the two states,
// `case.json` holds the rule's fields (`id` and `kind` are added) and the
// renames (`{ "<new path>": "<old path>" }`). The touched files are compared
// and parsed as buildReport does, and the rules run with the same context.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareFileWithFingerprints, type GitChange } from '../../src/core/diff/status.js';
import { loadTsMorph, readTsconfigPaths } from '../../src/core/path/graph.js';
import type { Report } from '../../src/core/report/types.js';
import { beforeFilesOf, mergeRules, rulesNeedTsconfigPaths, runRules, type RuleFile, type RuleRun } from '../../src/core/rules/index.js';
import { stageTree } from './fixture-repo.js';

export const LAYERS_CASES = 'rules/layers';
export const CASE_TIME = '2026-05-06T07:08:09.000Z';

export interface LayersCase {
  rule: Record<string, unknown>;
  renames?: Record<string, string>;
}

export function layersCase(name: string): LayersCase {
  const file = fileURLToPath(new URL(`../fixtures/${LAYERS_CASES}/${name}/case.json`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as LayersCase;
}

/** The rule entry of a case, as it would be written in settings.json. */
export function layersRule(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'layers', kind: 'layers', ...layersCase(name).rule, ...extra };
}

export interface CaseRun extends RuleRun {
  /** The touched files as the rules saw them. */
  files: RuleFile[];
}

/** Runs the case's rule (plus `extra` fields) over its touched files. */
export async function runLayersCase(name: string, extra: Record<string, unknown> = {}): Promise<CaseRun> {
  const config = layersCase(name);
  const before = stageTree(`${LAYERS_CASES}/${name}`, 'before');
  const after = stageTree(`${LAYERS_CASES}/${name}`, 'after');
  const renames = config.renames ?? {};
  const renamedFrom = new Set(Object.values(renames));

  const changed: { path: string; oldPath: string | null; type: GitChange }[] = [];
  for (const path of Object.keys(after).sort()) {
    const oldPath = renames[path];
    if (oldPath !== undefined) changed.push({ path, oldPath, type: 'rename' });
    else if (before[path] === undefined) changed.push({ path, oldPath: null, type: 'add' });
    else if (before[path] !== after[path]) changed.push({ path, oldPath: path, type: 'mod' });
  }
  for (const path of Object.keys(before).sort()) {
    if (after[path] === undefined && !renamedFrom.has(path)) changed.push({ path, oldPath: path, type: 'del' });
  }

  const files: RuleFile[] = [];
  for (const entry of changed) {
    const oldPath = entry.oldPath ?? entry.path;
    const compared = await compareFileWithFingerprints(
      {
        path: entry.path,
        ...(oldPath === entry.path ? {} : { oldPath }),
        change: entry.type,
        binary: false,
        before: entry.type === 'add' ? null : (before[oldPath] ?? null),
        after: entry.type === 'del' ? null : (after[entry.path] ?? null),
      },
      { imports: true },
    );
    files.push({
      path: entry.path,
      ...(oldPath === entry.path ? {} : { oldPath }),
      status: compared.status,
      symbols: compared.symbols,
      after: null,
      ...(compared.imports === undefined ? {} : { imports: compared.imports }),
    });
  }

  const rules = mergeRules({ settings: [layersRule(name, extra)] });
  const afterFiles = Object.keys(after).sort();
  const tsconfig = after['tsconfig.json'];
  const tsconfigPaths = rulesNeedTsconfigPaths(rules) && tsconfig !== undefined ? readTsconfigPaths(tsconfig, (await loadTsMorph()).ts) : null;
  const run = runRules(rules, files, CASE_TIME, {
    afterFiles: new Set(afterFiles),
    beforeFiles: new Set(beforeFilesOf(afterFiles, changed)),
    tsconfigPaths,
  });
  return { ...run, files };
}

/** `[file, line, title]` of each finding. */
export function findingRows(findings: Report['findings']): [string, number, string][] {
  return findings.map((finding) => [finding.file, finding.line, finding.title]);
}
