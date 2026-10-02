// e2e/change/draw-call-budget (ADR-026): the scene stays within 40 draw calls
// whatever the size of the change, on the golden Report and on 2,000 files.
// The frame rate from the bench is recorded as an annotation (SwiftShader
// here, so it says little about a real GPU).

import { expect, test } from '@playwright/test';
import { fixtures, mockApi } from '../../support/mock-api.js';
import { bench, openCity, stats } from '../../support/scene.js';

const BUDGET = 40;

for (const [name, report] of [
  ['golden', fixtures.reportGolden],
  ['2,000 files', fixtures.reportLargeCity],
] as const) {
  test(`change/draw-call-budget: ${name}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const data = report();
    await mockApi(page, { reports: { 11: data } });
    await openCity(page);
    const files = data.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);
    const scene = await stats(page);
    expect(scene.buildings).toBe(files);
    expect(scene.drawCalls).toBeGreaterThan(0);
    expect(scene.drawCalls).toBeLessThanOrEqual(BUDGET);
    expect(scene.labels).toBeLessThanOrEqual(120);

    const measured = await bench(page, 1500);
    expect(measured.drawCalls).toBeLessThanOrEqual(BUDGET);
    testInfo.annotations.push({ type: 'bench', description: `${name}: ${String(measured.drawCalls)} draw calls, ${String(measured.fps)} fps` });
  });
}
