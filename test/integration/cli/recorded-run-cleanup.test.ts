// DC-130: a process run under import-recorder.mjs never outlives its test. A
// recorded run that hangs is killed with its whole process group, on its own
// timeout or by DaemonTracker.cleanup() in afterEach; its stdin is closed
// unless the test feeds it; and the guard finds a recorded run that slipped
// past the tracker (the pattern that used to leave orphans for hours).

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { expectNoRecorderLeft, IMPORT_RECORDER, recorderProcessesLeft } from '../../helpers/import-recorder-guard.js';

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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Starts a grandchild that never exits (its command line names no file of
// this checkout, so only a group kill reaches it), prints its pid, then hangs.
const HANG_WITH_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' });",
  'process.stdout.write(`${String(grandchild.pid)}\\n`);',
  'setInterval(() => undefined, 1000);',
].join('\n');

function recordedEnv(): NodeJS.ProcessEnv {
  return { ...temp.env, DIFFCITY_TEST_IMPORT_LOG: join(temp.root, 'imports.log') };
}

async function grandchildOf(run: { stdout(): string }): Promise<number> {
  const line = await waitFor(() => (run.stdout().includes('\n') ? run.stdout() : undefined), 45_000, 'the grandchild pid');
  return Number(line.trim());
}

describe('recorded runs never outlive their test', () => {
  it('a recorded run that hangs is killed with its whole group when its timeout runs out', async () => {
    const run = daemons.spawn('-e', [HANG_WITH_GRANDCHILD], recordedEnv(), temp.userHome, ['--import', IMPORT_RECORDER], { group: true, timeoutMs: 3000 });
    const grandchild = await grandchildOf(run);
    expect(alive(grandchild)).toBe(true);
    expect(await run.exited).toBeNull();
    expect(run.timedOut()).toBe(true);
    await waitFor(() => !alive(grandchild), 5000, 'the grandchild to die with its group');
    expect(recorderProcessesLeft([temp.root])).toEqual([]);
  });

  it('cleanup kills a recorded run still hanging when its test gives up, grandchildren included', async () => {
    const run = daemons.spawn('-e', [HANG_WITH_GRANDCHILD], recordedEnv(), temp.userHome, ['--import', IMPORT_RECORDER], { group: true });
    const grandchild = await grandchildOf(run);
    expect(recorderProcessesLeft([temp.root]).map((target) => target.pid)).toEqual([run.child.pid]);
    await daemons.cleanup();
    expect(await run.exited).toBeNull();
    await waitFor(() => !alive(grandchild), 5000, 'the grandchild to die with its group');
    expect(recorderProcessesLeft([temp.root])).toEqual([]);
  });

  it('stdin is closed unless the test feeds it', async () => {
    const readAll = "let text = ''; process.stdin.setEncoding('utf8').on('data', (c) => (text += c)).on('end', () => process.stdout.write(`[${text}]`));";
    const closed = daemons.spawn('-e', [readAll], recordedEnv(), temp.userHome, ['--import', IMPORT_RECORDER], { group: true, timeoutMs: 45_000 });
    expect(await closed.exited).toBe(0);
    expect(closed.stdout()).toBe('[]');
    const fed = daemons.spawn('-e', [readAll], recordedEnv(), temp.userHome, ['--import', IMPORT_RECORDER], { group: true, input: 'hook json', timeoutMs: 45_000 });
    expect(await fed.exited).toBe(0);
    expect(fed.stdout()).toBe('[hook json]');
  });

  it('the guard finds a recorded run spawned outside the tracker, and kills it', async () => {
    // The pattern that used to leave orphans: no tracker, no registered home, stdin left open.
    const stray = spawn(process.execPath, ['--import', IMPORT_RECORDER, '-e', 'setInterval(() => undefined, 1000)'], { env: recordedEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<void>((resolve) => stray.once('exit', () => {
      resolve();
    }));
    await waitFor(() => recorderProcessesLeft().some((target) => target.pid === stray.pid), 45_000, 'the stray run to show up');
    expect(() => {
      expectNoRecorderLeft();
    }).toThrow(/import-recorder processes outlived their tests:\n {2}\d+ .*import-recorder\.mjs/);
    await exited;
    expect(recorderProcessesLeft()).toEqual([]);
  });
});
