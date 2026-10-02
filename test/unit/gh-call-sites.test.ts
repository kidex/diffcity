// Every call to gh must go through defaultRunner, whose environment carries the
// ADR-024 guards (ADR-032). This scans src/ so a new gh call cannot bypass ghEnv silently.

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

describe('gh call sites', () => {
  it('only the git exec module and two known launchers import child_process', () => {
    expect(withText(/node:child_process|from 'child_process'/).sort()).toEqual(['cli/open.ts', 'core/git/exec.ts', 'daemon/client.ts']);
  });

  it('the two launchers outside exec.ts never start gh', () => {
    for (const rel of ['cli/open.ts', 'daemon/client.ts']) {
      const text = files.find((f) => f.rel === rel)?.text ?? '';
      expect(text, rel).not.toMatch(/['"`]gh['"`]/);
    }
  });

  it('gh is started only in the files that call it through a runner', () => {
    expect(withText(/\(\s*['"`]gh['"`]/).sort()).toEqual(['core/changes/sources.ts', 'core/git/base.ts']);
  });

  it('every gh invocation goes through an injected CommandRunner, never a direct exec', () => {
    for (const rel of ['core/changes/sources.ts', 'core/git/base.ts']) {
      const text = files.find((f) => f.rel === rel)?.text ?? '';
      const calls = [...text.matchAll(/(\w+)\(\s*['"]gh['"]/g)].map((m) => m[1]);
      expect(calls.length, rel).toBeGreaterThan(0);
      expect(new Set(calls), rel).toEqual(new Set(['runner']));
    }
  });

  it('every runner in those files and in the collector defaults to defaultRunner', () => {
    const defaults = (rel: string): string[] =>
      [...(files.find((f) => f.rel === rel)?.text ?? '').matchAll(/\brunner: CommandRunner(?: = \w+)?|options\.(?:runner|gh) \?\? \w+/g)].map((m) => m[0]);
    for (const rel of ['core/changes/sources.ts']) {
      const found = defaults(rel);
      expect(found.length, rel).toBeGreaterThan(0);
      for (const d of found) expect(d, rel).toBe('runner: CommandRunner = defaultRunner');
    }
    expect(defaults('core/git/base.ts').filter((d) => d.includes('??'))).toEqual(['options.runner ?? defaultRunner']);
    expect(defaults('daemon/collector/collector.ts')).toContain('options.gh ?? defaultRunner');
  });

  it('defaultRunner passes ghEnv() as the child environment', () => {
    const exec = files.find((f) => f.rel === 'core/git/exec.ts')?.text ?? '';
    const runner = exec.slice(exec.indexOf('export const defaultRunner'), exec.indexOf('export function ghEnv'));
    expect(runner).toMatch(/env: ghEnv\(\)/);
  });
});
