// perf/huge-city-loads (ADR-026, DC-90): the `huge` preset (8,000 files, about
// 80,000 floors, 1,200 touched) is a stress run. It is generated here, in the
// OS temp directory (about 0.1 s), and served to the page; the city must draw
// its first frame within the scene timeout and stay within 40 draw calls.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import type { Report } from '../../../../src/core/report/types.js';
import { mockApi } from '../../support/mock-api.js';
import { openCity, stats, sceneExpect as expect } from '../../support/scene.js';
import { tagClient } from '../../support/sse.js';

// Tracing records the 13 MB Report response of the mocked API and its writer
// fails on close; the stress run needs no trace.
test.use({ trace: 'off' });

const generator = fileURLToPath(new URL('../../../fixtures/ui/gen-large-city.mjs', import.meta.url));

test('perf/huge-city-loads', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(join(tmpdir(), 'diffcity-huge-'));
  try {
    const out = join(dir, 'huge.json');
    const made = spawnSync(process.execPath, [generator, '--preset', 'huge', '--out', out], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`gen-large-city --preset huge failed:\n${made.stderr}`);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Report;
    const files = report.packages.reduce((sum, p) => sum + p.files.length, 0);
    expect(files).toBe(8000);

    await mockApi(page, { reports: { 11: report } });
    await tagClient(page, testInfo.testId);
    const started = Date.now();
    await openCity(page);
    // openCity waits for the first frame within the scene timeout.
    expect(Date.now() - started).toBeLessThan(30_000);
    await expect.poll(async () => (await stats(page)).drawCalls).toBeGreaterThan(0);
    expect((await stats(page)).drawCalls).toBeLessThanOrEqual(40);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
