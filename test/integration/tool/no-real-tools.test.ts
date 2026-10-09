// tool/no-real-tools-in-tests (ADR-032): no test starts a real gh, npm or
// claude. The sentinels come first on every worker's PATH, and the tool runner
// refuses a binary outside the temporary directory (test/helpers/tool-sentinel.ts).

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH_PROFILE, TEST_TOOLS_ENV, createLimiter, findOnPath, ghPrList, isInside, runTool } from '../../../src/core/exec/index.js';
import { SENTINEL_ENV, SENTINEL_MESSAGE, SENTINEL_TOOLS, TEST_TOOLS_ENV as HELPER_TEST_TOOLS_ENV } from '../../helpers/tool-sentinel.js';

const sentinelDir = (): string => {
  const dir = process.env[SENTINEL_ENV];
  if (dir === undefined) throw new Error(`${SENTINEL_ENV} is not set: test/setup/tools.ts did not run`);
  return dir;
};

/** The cwd of the runner calls: a repo of its own, so the sentinels are not inside it. */
let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'diffcity-no-real-tools-'));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('tool/no-real-tools-in-tests', () => {
  it.each(SENTINEL_TOOLS)('%s on the PATH of a test is the sentinel', async (name) => {
    const found = await findOnPath(name, process.env.PATH);
    expect(found).not.toBeNull();
    expect(isInside(found ?? '', await realpath(sentinelDir()))).toBe(true);
  });

  it('a direct spawn of gh, npm or claude reaches the sentinel, which fails', async () => {
    for (const name of SENTINEL_TOOLS) {
      const stderr = await new Promise<string>((resolve) => {
        execFile(name, ['--version'], { env: process.env }, (error, _stdout, err) => {
          expect(error, name).not.toBeNull();
          resolve(err);
        });
      });
      expect(stderr, name).toContain(SENTINEL_MESSAGE);
    }
  });

  it('the tool runner refuses a binary outside the temporary directory, whatever the PATH or settings say', async () => {
    expect(HELPER_TEST_TOOLS_ENV).toBe(TEST_TOOLS_ENV);
    expect(await realpath(process.env[TEST_TOOLS_ENV] ?? '')).toBe(await realpath(tmpdir()));
    // /bin/sh stands in for a real tool installed on the machine; it never runs.
    const outcome = await runTool(
      GH_PROFILE,
      ghPrList(),
      { cwd, parse: (json) => json },
      { toolSetting: () => Promise.resolve({ kind: 'path', path: '/bin/sh' }), limiter: createLimiter() },
    );
    expect(outcome).toMatchObject({ kind: 'error', message: expect.stringContaining('outside the test tool sandbox') as unknown });
  });

  it('gh through the runner with the inherited PATH gets the sentinel, never a real gh', async () => {
    const outcome = await runTool(GH_PROFILE, ghPrList(), { cwd, parse: (json) => json }, { limiter: createLimiter() });
    expect(outcome.kind).not.toBe('ok');
    expect(outcome.kind === 'ok' ? '' : outcome.message).toContain(SENTINEL_MESSAGE);
  });
});
