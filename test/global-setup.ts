// Builds dist/ once before any test file runs. Tests that spawn the built CLI
// rely on it; building per file would let one file run dist/ while another
// file's build rewrites it.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    throw new Error(`npm run build failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
}
