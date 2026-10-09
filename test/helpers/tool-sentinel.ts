// tool/no-real-tools-in-tests (ADR-032): the tests never start a real gh, npm
// or claude. Two layers keep it so:
//
// - sentinel binaries named gh, npm and claude, first on every test worker's
//   PATH (test/setup/tools.ts): a test, a daemon or a CLI it starts that looks
//   a tool up on the PATH finds the sentinel, which prints why on stderr and
//   exits 1 (gh then reads as "not authenticated here", as in a repo without
//   a GitHub remote). A test that wants a tool puts its own stub before it;
// - DIFFCITY_TEST_TOOLS, set to the temporary directory: the tool runner
//   refuses any binary outside it, even one reached through an explicit PATH
//   that leaves the sentinels out.
//
// The global setup writes the sentinels once per run and runs each once, so
// the first-exec check macOS makes on a fresh file (syspolicyd) is paid there.
//
// The setup file loads this module before every test file, so it imports
// neither src/ nor node:child_process: a test that mocks child_process
// (vi.mock) must still get its mock in the src modules it imports.

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** TEST_TOOLS_ENV of src/core/exec/tool.ts (no-real-tools.test.ts checks they match). */
export const TEST_TOOLS_ENV = 'DIFFCITY_TEST_TOOLS';

/** The tools no test may start for real. */
export const SENTINEL_TOOLS = ['gh', 'npm', 'claude'] as const;

/** The directory of the sentinels, set by the global setup for every worker. */
export const SENTINEL_ENV = 'DIFFCITY_TOOL_SENTINEL';

/** What a sentinel prints on stderr. */
export const SENTINEL_MESSAGE = 'blocked in diffcity tests: a test must put a stub';

/** Writes the sentinels into a new temporary directory and returns their paths. */
export function createSentinels(): { dir: string; paths: string[] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diffcity-tool-sentinel-')));
  const paths = SENTINEL_TOOLS.map((name) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\necho "${name}: ${SENTINEL_MESSAGE} on a temporary PATH" >&2\nexit 1\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
  });
  return { dir, paths };
}

export function removeSentinels(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Puts the sentinels first on this process's PATH and confines the tool
 * runner to the temporary directory; every process a test starts inherits both.
 */
export function installSentinels(env: NodeJS.ProcessEnv = process.env): { dir: string; created: boolean } {
  const inherited = env[SENTINEL_ENV];
  const dir = inherited ?? createSentinels().dir;
  env[SENTINEL_ENV] = dir;
  env.PATH = `${dir}${delimiter}${env.PATH ?? ''}`;
  env[TEST_TOOLS_ENV] = realpathSync(tmpdir());
  return { dir, created: inherited === undefined };
}
