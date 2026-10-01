// Whether `gh` can list PRs (ADR-020, SPEC.md section 3a C5): `gh --version` and
// `gh auth status` both exit with code 0. The answer is cached for an hour per
// daemon; when gh is missing or not authenticated the PR step is skipped
// silently, with no error on the repo and no PR archived (ADR-019).

import type { CommandRunner } from '../../core/git/index.js';

export const GH_PROBE_TTL_MS = 60 * 60 * 1000;
const GH_PROBE_TIMEOUT_MS = 5000;

export interface GhProbe {
  /** True when gh is installed and authenticated; `cwd` is where gh runs. */
  available(cwd: string): Promise<boolean>;
}

export function createGhProbe(runner: CommandRunner, now: () => Date, ttlMs: number = GH_PROBE_TTL_MS): GhProbe {
  let cached: { at: number; value: Promise<boolean> } | null = null;

  const probe = async (cwd: string): Promise<boolean> => {
    try {
      await Promise.all([
        runner('gh', ['--version'], { cwd, timeoutMs: GH_PROBE_TIMEOUT_MS }),
        runner('gh', ['auth', 'status'], { cwd, timeoutMs: GH_PROBE_TIMEOUT_MS }),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  return {
    available(cwd) {
      const time = now().getTime();
      if (cached === null || time - cached.at >= ttlMs) cached = { at: time, value: probe(cwd) };
      return cached.value;
    },
  };
}
