// Builds the Node part of dist/ (build:node; the UI is built only for
// Playwright, ADR-022) once before any test file runs, and again before every
// rerun in watch mode. Tests that spawn the built CLI rely on it; building per
// file would let one file run dist/ while another file's build rewrites it.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

function buildDist(): void {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const build = spawnSync('npm', ['run', 'build:node'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    throw new Error(`npm run build:node failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
}

export default function setup(project: TestProject): void {
  buildDist();
  project.onTestsRerun(buildDist);
}
