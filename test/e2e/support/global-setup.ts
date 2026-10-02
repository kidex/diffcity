// Playwright global setup (ADR-023): the full build, node and UI, before any
// spec, and the generated fixtures (the 2,000-file Report of the change
// screen's scale tests). DIFFCITY_E2E_SKIP_BUILD=1 reuses an existing dist/
// for quick local runs; the fixtures are generated either way.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const generate = spawnSync(process.execPath, ['test/fixtures/ui/gen-large-city.mjs'], { cwd: repoRoot, encoding: 'utf8' });
  if (generate.status !== 0) throw new Error(`gen-large-city failed (${String(generate.status)}):\n${generate.stderr}`);
  if (process.env['DIFFCITY_E2E_SKIP_BUILD'] === '1') return;
  const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (build.status !== 0) {
    throw new Error(`npm run build failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
  }
}
