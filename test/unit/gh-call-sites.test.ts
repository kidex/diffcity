// gh/call-sites-use-runner (ADR-032): every gh call goes through a
// CommandRunner whose real implementation is the hardened tool runner, and
// only the tool runner starts external tools. This scans src/ so a new gh call
// cannot bypass it silently.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ rel: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
const withText = (re: RegExp): string[] => files.filter((f) => re.test(f.text)).map((f) => f.rel);
const textOf = (rel: string): string => files.find((f) => f.rel === rel)?.text ?? '';

describe('gh/call-sites-use-runner', () => {
  it('only the git runner, the tool runner and two known launchers import child_process', () => {
    expect(withText(/node:child_process|from 'child_process'/).sort()).toEqual(['cli/open.ts', 'core/exec/tool.ts', 'core/git/exec.ts', 'daemon/client.ts']);
  });

  it('the launchers and the git runner never start gh', () => {
    for (const rel of ['cli/open.ts', 'daemon/client.ts', 'core/git/exec.ts']) {
      expect(textOf(rel), rel).not.toMatch(/['"`]gh['"`]/);
    }
  });

  it('gh is started only in the files that call it through a runner', () => {
    expect(withText(/\(\s*['"`]gh['"`]/).sort()).toEqual(['core/changes/sources.ts', 'core/git/base.ts']);
  });

  it('every gh invocation goes through an injected CommandRunner, with an argv from a gh builder', () => {
    for (const rel of ['core/changes/sources.ts', 'core/git/base.ts']) {
      const text = textOf(rel);
      const calls = [...text.matchAll(/(\w+)\(\s*['"]gh['"],\s*([^,]+),/g)];
      expect(calls.length, rel).toBeGreaterThan(0);
      for (const [, callee, argv] of calls) {
        expect(callee, rel).toBe('runner');
        // A builder or a builder's constant, never a literal array.
        expect(argv, rel).toMatch(/^(?:GH_PR_LIST_ARGS|GH_REPO_VIEW_ARGV|gh[A-Z]\w*\([^)]*\)\.argv)$/);
      }
    }
  });

  it('every runner in those files and in the collector defaults to the tool runner adapter', () => {
    const defaults = (rel: string): string[] =>
      [...textOf(rel).matchAll(/\brunner: CommandRunner(?: = \w+)?|options\.(?:runner|gh) \?\? \w+/g)].map((m) => m[0]);
    const sourcesDefaults = defaults('core/changes/sources.ts');
    expect(sourcesDefaults.length).toBeGreaterThan(0);
    for (const d of sourcesDefaults) expect(d).toBe('runner: CommandRunner = defaultRunner');
    expect(defaults('core/git/base.ts').filter((d) => d.includes('??'))).toEqual(['options.runner ?? defaultRunner']);
    expect(defaults('daemon/collector/collector.ts')).toContain('options.gh ?? defaultRunner');
    for (const rel of ['core/changes/sources.ts', 'core/git/base.ts']) {
      expect(textOf(rel), rel).toMatch(/import \{ defaultRunner \} from '\.\.\/exec\/gh\.js';/);
    }
    expect(textOf('core/git/index.ts')).toMatch(/export \{ defaultRunner \} from '\.\.\/exec\/gh\.js';/);
  });

  it('defaultRunner is the gh adapter over runTool, and the daemon gives it its context', () => {
    const gh = textOf('core/exec/gh.ts');
    expect(gh).toMatch(/export const defaultRunner: CommandRunner = createGhRunner\(/);
    expect(gh).toMatch(/await runTool\(\s*GH_PROFILE,/);
    expect(textOf('daemon/collector/plugin.ts')).toMatch(/options\.gh \?\?\s*createGhRunner\(\{/);
  });

  it('the tool runner spawns without a shell, in its own process group', () => {
    const tool = textOf('core/exec/tool.ts');
    expect(tool).toMatch(/shell: false,/);
    expect(tool).toMatch(/detached: true,/);
    expect(tool).not.toMatch(/\bexec\(|execSync|shell: true/);
  });
});
