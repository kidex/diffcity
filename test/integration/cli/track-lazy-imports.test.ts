// `track` runs from the shell hook on every repo entry, so it must stay light
// (ADR-016): program.ts loads each command module lazily and the track module
// never pulls in the parser (web-tree-sitter) or src/core/report. `import`
// (ADR-036) loads the findings parsers (pure JSON code) but neither
// web-tree-sitter, ts-morph, src/core/report nor src/core/parse; neither does
// `setup-claude` (ADR-037), which loads only src/core/claude and the git root
// probe. Runs the built CLI with a module recorder preloaded and inspects what
// Node loaded. Every run goes through DaemonTracker in its own process group,
// with a timeout, and the guard checks that none outlives the file (DC-130).

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker } from '../../helpers/daemon.js';
import { startFakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { expectNoRecorderLeft, IMPORT_RECORDER } from '../../helpers/import-recorder-guard.js';
import { createRepo } from '../../helpers/repo.js';

isolateGitConfig();

/** Below the 60 s test timeout: a run that hangs is killed and fails its test with a clear message. */
const RUN_TIMEOUT_MS = 45_000;

let temp: TempHome;
const daemons = new DaemonTracker();
beforeEach(async () => {
  temp = await tempHome();
  daemons.track(temp.home);
});
afterEach(async () => {
  await daemons.cleanup();
  await temp.cleanup();
});
afterAll(expectNoRecorderLeft);

/** Runs the built CLI (in an empty directory unless `cwd` is given) and returns the URLs of every module it loaded. */
async function loadedModules(args: string[], cwd = temp.userHome): Promise<string[]> {
  return (await runRecorded(args, cwd)).urls;
}

/**
 * Runs the built CLI under the recorder (stdin closed unless `input` is
 * given) and returns its stdout and the URLs of every module it loaded. The
 * log starts empty for each run.
 */
async function runRecorded(args: string[], cwd: string, options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<{ urls: string[]; stdout: string }> {
  const log = join(temp.root, 'imports.log');
  await rm(log, { force: true });
  const env = { ...(options.env ?? temp.env), DIFFCITY_TEST_IMPORT_LOG: log };
  const run = daemons.spawn(CLI_DIST, args, env, cwd, ['--import', IMPORT_RECORDER], { group: true, timeoutMs: RUN_TIMEOUT_MS, ...(options.input === undefined ? {} : { input: options.input }) });
  // The exit code is not the point here: only what got loaded on the way.
  await run.exited;
  if (run.timedOut()) throw new Error(`diffcity ${args.join(' ')} did not exit within ${String(RUN_TIMEOUT_MS)} ms; stderr: ${run.stderr()}`);
  return { urls: (await readFile(log, 'utf8')).split('\n').filter((line) => line !== ''), stdout: run.stdout() };
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

  it('track/lazy-imports-unchanged: track --agent with a session in the hook JSON forwards it without loading the session parser', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/cart/total.ts': 'export const total = 1;\n' } });
    const fake = await startFakeDaemon(homePaths(temp.home));
    try {
      const hook = JSON.stringify({ session_id: 'deadbeef-0001', transcript_path: '/claude/projects/p/deadbeef-0001.jsonl', cwd: repo.dir, hook_event_name: 'Stop' });
      const { urls, stdout } = await runRecorded(['track', '--agent'], temp.userHome, { input: hook });
      expect(stdout).toBe('tracked sample-shop\n');
      expect(fake.requests).toMatchObject([{ type: 'track', agent: true, session: { sessionId: 'deadbeef-0001', event: 'Stop' } }]);
      expect(urls.some((url) => url.endsWith('/dist/cli/track.js'))).toBe(true);
      expect(urls.filter((url) => url.includes('/dist/core/session/'))).toEqual([]);
      expect(urls.filter(loadsParser)).toEqual([]);
      expect(urls.filter(loadsTsMorph)).toEqual([]);
      expect(urls.filter(loadsReport)).toEqual([]);
    } finally {
      await fake.close();
      await repo.cleanup();
    }
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

  it('cli/setup-claude-lazy-imports: setup-claude (user and --repo) loads src/core/claude but neither the code parser, ts-morph, src/core/report nor src/core/parse', async () => {
    const repo = await createRepo({ name: 'sample-shop', files: { 'src/cart/total.ts': 'export const total = 1;\n' } });
    try {
      const claudeDir = join(temp.root, 'claude-config');
      const runs: [string[], string][] = [
        [['setup-claude'], temp.userHome],
        [['setup-claude', '--repo'], repo.dir],
      ];
      for (const [args, cwd] of runs) {
        const { urls, stdout } = await runRecorded(args, cwd, { env: { ...temp.env, CLAUDE_CONFIG_DIR: claudeDir } });
        // A real run: it wrote the files.
        expect(stdout).toMatch(/^created .*diffcity-review\.md$/m);
        expect(urls.some((url) => url.endsWith('/dist/cli/setup-claude.js'))).toBe(true);
        expect(urls.some((url) => url.endsWith('/dist/core/claude/setup.js'))).toBe(true);
        expect(urls.filter(loadsParser)).toEqual([]);
        expect(urls.filter(loadsTsMorph)).toEqual([]);
        expect(urls.filter(loadsReport)).toEqual([]);
        expect(urls.filter((url) => url.includes('/dist/core/parse/'))).toEqual([]);
        expect(urls.filter((url) => /\/dist\/cli\/(?:diff|track|import|open)\.js$/.test(url))).toEqual([]);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it('--help loads no command module', async () => {
    const urls = await loadedModules(['--help']);
    expect(urls.some((url) => url.endsWith('/dist/cli/program.js'))).toBe(true);
    expect(urls.filter((url) => /\/dist\/cli\/(?:track|diff|import|setup-claude)\.js$/.test(url))).toEqual([]);
    expect(urls.filter(loadsParser)).toEqual([]);
  });

  it('the recorder sees the parser when a command does load it (diff)', async () => {
    const urls = await loadedModules(['diff']);
    expect(urls.some((url) => url.endsWith('/dist/cli/diff.js'))).toBe(true);
    expect(urls.some(loadsParser)).toBe(true);
    expect(urls.some(loadsReport)).toBe(true);
  });
});
