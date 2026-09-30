// Isolates the git calls made by src/core/git from the machine's global and
// system git config, the same way test/helpers/repo.ts isolates its own calls.

import { devNull } from 'node:os';
import { afterEach, beforeEach, vi } from 'vitest';
import type { CommandRunner } from '../../src/core/git/index.js';

export function isolateGitConfig(): void {
  beforeEach(() => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

export interface RecordedCall {
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

/** A fake external command runner: records every call and answers through `answer`. */
export function fakeRunner(answer: (call: RecordedCall) => string): { runner: CommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = (file, args, options) => {
    const call = { file, args, cwd: options.cwd, timeoutMs: options.timeoutMs };
    calls.push(call);
    try {
      return Promise.resolve(answer(call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { runner, calls };
}

/** A runner that behaves like a machine without `gh` installed. */
export function ghMissing(): { runner: CommandRunner; calls: RecordedCall[] } {
  return fakeRunner(() => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  });
}

/** A runner that fails the test if it is ever called. */
export function ghForbidden(): { runner: CommandRunner; calls: RecordedCall[] } {
  return fakeRunner((call) => {
    throw new Error(`unexpected external command: ${call.file} ${call.args.join(' ')}`);
  });
}
