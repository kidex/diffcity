// Lists the visual baselines that are not committed yet, one path per line
// (nothing when every baseline is there):
//
//   node scripts/visual-baselines.mjs
//
// A visual spec (test/e2e/screens/**/visual-*.spec.ts) names each of its
// screenshots in a `toHaveScreenshot('<name>.png', ...)` call. The baselines
// are rendered on Linux CI, so the file Playwright looks for on that platform
// is `<spec>-snapshots/<name>-screens-linux.png`. CI runs this before the
// baseline job: when it prints a path, the job generates the images with
// `--update-snapshots=missing` and uploads them (.github/workflows/ci.yml).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'test', 'e2e', 'screens');

/** Every `visual-*.spec.ts` under `folder`, as absolute paths, sorted. */
function visualSpecs(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...visualSpecs(path));
    else if (/^visual-.*\.spec\.ts$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

const missing = [];
for (const spec of visualSpecs(dir)) {
  const names = [...readFileSync(spec, 'utf8').matchAll(/toHaveScreenshot\(\s*'([^']+)\.png'/g)].map((match) => match[1]);
  for (const name of names) {
    const baseline = `${spec}-snapshots/${name}-screens-linux.png`;
    if (!existsSync(baseline)) missing.push(relative(root, baseline).split(sep).join('/'));
  }
}
if (missing.length > 0) console.log(missing.join('\n'));
