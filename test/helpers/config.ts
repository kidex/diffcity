// Temporary diffcity homes for tests (ADR-015). Tests never touch the real
// ~/.config/diffcity: test/setup/home.ts points DIFFCITY_HOME and HOME at a
// tempHome() for every test file, and tests that spawn the CLI or the daemon
// pass `env` from a tempHome() explicitly.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_ENV } from '../../src/core/home.js';

export interface TempHome {
  /** Temporary directory holding both homes; cleanup removes it. */
  readonly root: string;
  /** Value for DIFFCITY_HOME. Not created, so the code under test creates it (mode 0700). */
  readonly home: string;
  /** Value for HOME. Created and empty. */
  readonly userHome: string;
  /** process.env with DIFFCITY_HOME and HOME replaced; pass it to spawned processes. */
  readonly env: NodeJS.ProcessEnv;
  /** Removes the root directory and everything under it. */
  cleanup(): Promise<void>;
}

/**
 * Creates `<os.tmpdir()>/dc-XXXXXX/` with `home` (the diffcity home) and `user`
 * (HOME) inside. The prefix stays short so `<home>/daemon.sock` fits the
 * socket path limit on the usual temporary directories.
 */
export async function tempHome(): Promise<TempHome> {
  const root = await mkdtemp(join(tmpdir(), 'dc-'));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  await mkdir(userHome);
  return {
    root,
    home,
    userHome,
    env: { ...process.env, [HOME_ENV]: home, HOME: userHome },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
