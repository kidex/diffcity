// `track` runs from the shell hook on every repo entry, so it must stay light
// (ADR-016): program.ts loads each command module lazily and the track module
// never pulls in the parser (web-tree-sitter) or src/core/report. Runs the
// built CLI with a module recorder preloaded and inspects what Node loaded.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempHome, type TempHome } from '../../helpers/config.js';

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

/** Runs the built CLI in an empty directory and returns the URLs of every module it loaded. */
async function loadedModules(args: string[]): Promise<string[]> {
  const log = join(temp.root, 'imports.log');
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      ['--import', recorder, cliEntry, ...args],
      { cwd: temp.userHome, env: { ...temp.env, DIFFCITY_TEST_IMPORT_LOG: log } },
      // The exit code is not the point here: only what got loaded on the way.
      () => {
        resolve();
      },
    );
  });
  return (await readFile(log, 'utf8')).split('\n').filter((line) => line !== '');
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

  it('--help loads no command module', async () => {
    const urls = await loadedModules(['--help']);
    expect(urls.some((url) => url.endsWith('/dist/cli/program.js'))).toBe(true);
    expect(urls.filter((url) => /\/dist\/cli\/(?:track|diff)\.js$/.test(url))).toEqual([]);
    expect(urls.filter(loadsParser)).toEqual([]);
  });

  it('the recorder sees the parser when a command does load it (diff)', async () => {
    const urls = await loadedModules(['diff']);
    expect(urls.some((url) => url.endsWith('/dist/cli/diff.js'))).toBe(true);
    expect(urls.some(loadsParser)).toBe(true);
    expect(urls.some(loadsReport)).toBe(true);
  });
});
