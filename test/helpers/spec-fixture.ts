// Loads a spec fixture (a case directory under test/fixtures/spec with a
// before and an after tree and a spec.md) and runs spec scope on it the way
// buildReport does: every file compared (code files parsed, the others by
// presence), the execution path built over the touched code files and the
// untouched ones that register entry points, then specScope over its call
// graph and routes, and assembleReport for the verdicts. No git, no disk
// writes.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFileWithFingerprints } from '../../src/core/diff/status.js';
import { languageForPath } from '../../src/core/parse/language.js';
import { buildExecutionPath } from '../../src/core/path/order.js';
import { preparePathFile, prepareUntouchedFile, type PathFile } from '../../src/core/path/prepare.js';
import { assembleReport, type ReportFileInput } from '../../src/core/report/build.js';
import type { Finding, Report } from '../../src/core/report/types.js';
import type { RuleRun } from '../../src/core/rules/index.js';
import { specScope, type LinkBase, type SpecScope } from '../../src/core/spec/index.js';
import { tier1Matcher } from '../../src/core/verdict/index.js';

const fixtures = fileURLToPath(new URL('../fixtures/spec/', import.meta.url));

function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))
    .sort();
}

function readSide(root: string): Map<string, string> {
  return new Map(walk(root).map((path) => [path, readFileSync(join(root, path), 'utf8')]));
}

/** A file of the fixture itself, outside its trees. */
export function specFixtureFile(name: string, file: string): string {
  return readFileSync(join(fixtures, name, file), 'utf8');
}

export interface SpecCase {
  scope: SpecScope;
  report: Report;
  /** `inSpec` of every file of the Report, by path, in report order. */
  inSpec: Record<string, boolean | null>;
}

export interface SpecCaseOptions {
  /** The spec text; defaults to the fixture's spec.md. */
  text?: string;
  /** Repo-relative path of the spec file. Default `.diffcity/spec.md`. */
  specPath?: string | null;
  /** Where link targets resolve; default: from the directory of `specPath`. */
  linkBase?: LinkBase | null;
  /** Findings that count for the verdicts, as rule findings do. */
  findings?: Finding[];
}

export async function specCase(name: string, options: SpecCaseOptions = {}): Promise<SpecCase> {
  const root = join(fixtures, name);
  const before = readSide(join(root, 'before'));
  const after = readSide(join(root, 'after'));
  const inputs: ReportFileInput[] = [];
  const pathFiles: PathFile[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(path) ?? null;
    const a = after.get(path) ?? null;
    const change = b === null ? 'add' : a === null ? 'del' : b === a ? null : 'mod';
    const code = languageForPath(path) !== null;
    if (change === null && !code) continue;
    const { status, symbols, ranges } = await compareFileWithFingerprints({ path, change: change ?? 'mod', binary: !code, before: b, after: a });
    inputs.push({ path, language: languageForPath(path) ?? 'other', status, symbols });
    if (!code) continue;
    if (status === 'same') {
      const untouched = a === null ? null : await prepareUntouchedFile(path, a, symbols);
      if (untouched !== null) pathFiles.push(untouched);
    } else {
      pathFiles.push(await preparePathFile({ path, status, before: b, after: a, symbols, ranges }));
    }
  }
  const path = await buildExecutionPath({ files: pathFiles, tsconfig: null, packageJson: null });
  const scope = specScope({
    text: options.text ?? specFixtureFile(name, 'spec.md'),
    specPath: options.specPath === undefined ? '.diffcity/spec.md' : options.specPath,
    ...(options.linkBase === undefined ? {} : { linkBase: options.linkBase }),
    files: inputs,
    edges: path.edges,
    routes: path.routes,
  });
  const rules: RuleRun | null = options.findings === undefined ? null : { findings: options.findings, checks: [] };
  const report = assembleReport(
    { repo: 'bakery', base: 'main', head: 'feature/work', commits: 1, generatedAt: '2026-10-09T08:00:00.000Z' },
    inputs,
    tier1Matcher(undefined),
    path,
    rules,
    scope,
  );
  const inSpec = Object.fromEntries(report.packages.flatMap((pkg) => pkg.files.map((file) => [file.path, file.inSpec])));
  return { scope, report, inSpec };
}
