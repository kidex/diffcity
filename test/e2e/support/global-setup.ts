// Playwright global setup (ADR-023): the full build, node and UI, before any
// spec. DIFFCITY_E2E_SKIP_BUILD=1 reuses an existing dist/ for quick local runs.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  if (process.env['DIFFCITY_E2E_SKIP_BUILD'] === '1') return;
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    throw new Error(`npm run build failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
}
