// `track` runs from the shell hook on every repo entry, so it must stay light
// (ADR-016): program.ts loads each command module lazily and the track module
// never pulls in the parser (web-tree-sitter) or src/core/report. `import`
// (ADR-036) loads the findings parsers (pure JSON code) but neither
// web-tree-sitter, ts-morph, src/core/report nor src/core/parse. Runs the
// built CLI with a module recorder preloaded and inspects what Node loaded.

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { startFakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo } from '../../helpers/repo.js';

isolateGitConfig();

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');
const recorder = join(repoRoot, 'test', 'helpers', 'import-recorder.mjs');

let temp: TempHome;
beforeEach(async () => {
  temp = await tempHome();
});
afterEach(async () => {
  await temp.cleanup();
});

/** Runs the built CLI (in an empty directory unless `cwd` is given) and returns the URLs of every module it loaded. */
async function loadedModules(args: string[], cwd = temp.userHome): Promise<string[]> {
  return (await runRecorded(args, cwd)).urls;
}

async function runRecorded(args: string[], cwd: string): Promise<{ urls: string[]; stdout: string }> {
  const log = join(temp.root, 'imports.log');
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      ['--import', recorder, cliEntry, ...args],
      { cwd, env: { ...temp.env, DIFFCITY_TEST_IMPORT_LOG: log } },
      // The exit code is not the point here: only what got loaded on the way.
      (_error, out) => {
        resolve(out);
      },
    );
  });
  return { urls: (await readFile(log, 'utf8')).split('\n').filter((line) => line !== ''), stdout };
}

const loadsParser = (url: string): boolean => url.includes('/node_modules/web-tree-sitter/');
const loadsTsMorph = (url: string): boolean => url.includes('/node_modules/ts-morph/') || url.includes('/node_modules/@ts-morph/');
const loadsReport = (url: string): boolean => /\/dist\/core\/report\//.test(url);

describe('lazy command modules', () => {
  it('cli/track-lazy-imports: track loads its own module but neither web-tree-sitter nor src/core/report', async () => {
    const urls = await loadedModules(['track', temp.userHome]);
    expect(urls.some((url) => url.endsWith('/dist/cli/track.js'))).toBe(true);
    expect(urls.filter(loadsParser)).toEqual([]);
    expect(urls.filter(loadsReport)).toEqual([]);
    expect(urls.filter((url) => url.endsWith('/dist/cli/diff.js'))).toEqual([]);
  });

  it('graph/ts-morph-not-loaded-by-track: neither track nor --help loads ts-morph', async () => {
    const tracked = await loadedModules(['track', temp.userHome]);
    expect(tracked.filter(loadsTsMorph)).toEqual([]);
    const help = await loadedModules(['--help']);
    expect(help.filter(loadsTsMorph)).toEqual([]);
  });

  it('graph/ts-morph-not-loaded-by-import: import does not load ts-morph', async () => {
    const urls = await loadedModules(['import', 'findings.json']);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter(loadsTsMorph)).toEqual([]);
  });

  it('cli/import-lazy-imports: a full import loads the findings parsers but neither the code parser, ts-morph, src/core/report nor src/core/parse', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/cart/total.ts': 'export const total = 1;\n' } });
    const fake = await startFakeDaemon(homePaths(temp.home));
    try {
      const findings = [{ source: 'claude', severity: 'low', category: 'style', file: 'src/cart/total.ts', line: 1, title: 'Invented', message: 'An invented finding.' }];
      await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(findings));
      const { urls, stdout } = await runRecorded(['import', 'findings.json'], repo.dir);
      // The import went through: the module list is the one of a real run.
      expect(stdout).toBe('Imported 1 finding into feature/totals (0 merged, 0 skipped, 0 fixed)\n');
      expect(fake.requests).toHaveLength(1);
      expect(urls.some((url) => url.endsWith('/dist/cli/import.js'))).toBe(true);
      expect(urls.some((url) => url.endsWith('/dist/core/findings/parse.js'))).toBe(true);
      expect(urls.filter(loadsParser)).toEqual([]);
      expect(urls.filter(loadsTsMorph)).toEqual([]);
      expect(urls.filter(loadsReport)).toEqual([]);
      expect(urls.filter((url) => url.includes('/dist/core/parse/'))).toEqual([]);
    } finally {
      await fake.close();
      await repo.cleanup();
    }
  });

  it('--help loads no command module', async () => {
    const urls = await loadedModules(['--help']);
    expect(urls.some((url) => url.endsWith('/dist/cli/program.js'))).toBe(true);
    expect(urls.filter((url) => /\/dist\/cli\/(?:track|diff|import)\.js$/.test(url))).toEqual([]);
    expect(urls.filter(loadsParser)).toEqual([]);
  });

  it('the recorder sees the parser when a command does load it (diff)', async () => {
    const urls = await loadedModules(['diff']);
    expect(urls.some((url) => url.endsWith('/dist/cli/diff.js'))).toBe(true);
    expect(urls.some(loadsParser)).toBe(true);
    expect(urls.some(loadsReport)).toBe(true);
  });
});
