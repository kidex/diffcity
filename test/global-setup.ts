// Builds the Node part of dist/ (build:node; the UI is built only for
// Playwright, ADR-022) once before any test file runs, and again before every
// rerun in watch mode. Tests that spawn the built CLI rely on it; building per
// file would let one file run dist/ while another file's build rewrites it.
//
// It also creates the run's daemon registry (test/helpers/daemons.ts, DC-58):
// the workers inherit its path and record every temporary home that may get a
// daemon; the teardown stops whatever still runs in any of them, even for a
// worker that died. Registries left by an earlier run that was killed before
// its teardown are swept first.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { createRunRegistry, sweepRunRegistry, sweepStaleRegistries } from './helpers/daemons.js';

function buildDist(): void {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const build = spawnSync('npm', ['run', 'build:node'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    throw new Error(`npm run build:node failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  await sweepStaleRegistries();
  const registry = createRunRegistry();
  buildDist();
  project.onTestsRerun(buildDist);
  return async () => {
    await sweepRunRegistry(registry);
  };
}
