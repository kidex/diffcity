// e2e/change/golden-three-scenarios (SPEC.md section 9, phase 3 exit criterion
// 1): the real daemon from dist/, in a temporary DIFFCITY_HOME, collects the
// three golden changes (order-discounts, session-refresh, report-cli-command).
// On each one the change screen has the mockup's elements, with the numbers
// the daemon's own stats carry: top bar counters, verdict and type filter rows
// with their counts, the legend, roof labels with verdict tags, the tooltip,
// the selection card, the panel tabs and the file view with the real diff.
// golden/reading-path-real-steps (DC-140): on the same daemon, the Execution
// order tab shows each scenario's hand-reviewed path
// (test/integration/golden-review.ts) section by section, every stop with its
// `why` and, where the step has one, its inline diff.

import type { Page } from '@playwright/test';
import type { FileDiff } from '../../../src/core/model/types.js';
import type { Report, Step } from '../../../src/core/report/types.js';
import { reviewed, type ReviewedStep } from '../../integration/golden-review.js';
import { GOLDEN, getJson, stubEnv, trackScenario, type GoldenName, type TrackedChange } from '../support/change-daemon.js';
import { expect, test } from '../support/proof.js';
import { hovered, project, sceneExpect, waitForCityAttribute, waitReady } from '../support/scene.js';
import { stopSection, stopSections } from '../support/panel.js';

const VERDICTS = [
  ['eyes', 'Needs your eyes'],
  ['risky', 'Risky'],
  ['spec', 'Outside the spec'],
  ['ok', 'Reviewed, fine'],
  ['same', 'Untouched'],
] as const;
const TYPES = [
  ['add', 'Added'],
  ['mod', 'Modified'],
  ['sig', 'Signature changed'],
  ['del', 'Removed'],
] as const;

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

test('change/golden-three-scenarios', async ({ proof, page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const env = await stubEnv(proof);
  await proof.startDaemon(env);

  for (const name of GOLDEN) {
    await test.step(name, async () => {
      const tracked = await trackScenario(proof, env, name);
      const report = await tracked.report();
      await openChange(page, tracked);
      await topBar(page, tracked, report);
      await filtersAndLegend(page, tracked);
      await labelsAndTooltip(page, tracked, report);
      await selectionAndFileView(page, proof.baseURL, tracked, report);
      await panelTabs(page, report);
      await test.step(`golden/reading-path-real-steps: ${name}`, () => readingPath(page, name, report));
    });
  }
});

async function openChange(page: Page, tracked: TrackedChange): Promise<void> {
  // A blank page first: each change is a fresh mount of the screen.
  await page.goto('about:blank');
  await page.goto(tracked.url);
  await waitReady(page);
}

async function topBar(page: Page, tracked: TrackedChange, report: Report): Promise<void> {
  const stats = tracked.change.stats;
  if (stats === null) throw new Error('the change has no stats');
  const { steps } = tracked.scenario;
  const files = report.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);

  await expect(page.getByRole('link', { name: 'diffcity, all repos' })).toBeVisible();
  const crumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumb).toContainText(steps.repo);
  await expect(crumb).toContainText(steps.branch);
  await expect(crumb.getByText('against')).toBeVisible();
  await expect(crumb.getByText(steps.base, { exact: true })).toBeVisible();
  await expect(crumb).toContainText(new RegExp(`${String(report.meta.commits)} commits?, `));

  await expect(page.getByTestId('change-ref')).toHaveText(steps.branch);
  await expect(page.getByTestId('stat-files')).toHaveText(`${String(files)}files`);
  await expect(page.getByTestId('stat-add')).toHaveText(`${String(stats.symbolsByStatus.add)}added`);
  await expect(page.getByTestId('stat-mod')).toHaveText(`${String(stats.symbolsByStatus.mod)}modified`);
  await expect(page.getByTestId('stat-sig')).toHaveText(`${String(stats.symbolsByStatus.sig)}signature`);
  await expect(page.getByTestId('stat-del')).toHaveText(`${String(stats.symbolsByStatus.del)}removed`);
  await expect(page.getByTestId('eyes-badge')).toHaveText(`${String(stats.filesByVerdict.eyes)} files need your eyes before merge`);
  await expect(page.getByTestId('progress-attention')).toHaveText(`0 of ${String(stats.filesByVerdict.eyes)} files that need your eyes checked`);
  await expect(page.getByTestId('progress-touched')).toHaveText(`0 of ${String(stats.touchedFiles)} touched files checked`);
  // The review controls are present with a daemon; export is a disabled placeholder. While touched tier 1 files
  // are unmarked, Approve is "Check the rest and approve" (DC-135).
  await expect(page.getByRole('button', { name: 'Review summary' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export PlantUML' })).toBeVisible();
  await expect(page.getByRole('button', { name: report.summary.tier1Files.length > 0 ? 'Check the rest and approve' : 'Approve', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What the agent built' })).toBeVisible();
  await expect(page.getByTestId('hint')).toContainText('Drag to orbit, scroll to zoom');
}

async function filtersAndLegend(page: Page, tracked: TrackedChange): Promise<void> {
  const stats = tracked.change.stats;
  if (stats === null) throw new Error('the change has no stats');
  const verdicts = page.getByRole('group', { name: 'Filter by verdict' });
  for (const [key, label] of VERDICTS) {
    await expect(verdicts.getByTestId(`filter-verdict-${key}`)).toHaveText(`${label}${String(stats.filesByVerdict[key])}`);
  }
  const types = page.getByRole('group', { name: 'Filter by change type' });
  for (const [key, label] of TYPES) {
    await expect(types.getByTestId(`filter-type-${key}`)).toHaveText(`${label}${String(stats.symbolsByStatus[key])}`);
  }
  await expect(types.getByRole('button', { name: 'Show everything' })).toBeVisible();
  // No rule findings from a plain collection: no Rules row, no rule marker in the legend.
  await expect(page.getByRole('group', { name: 'Filter by rule' })).toHaveCount(0);
  const legend = page.getByRole('group', { name: 'Legend' });
  for (const label of ['needs your eyes', 'risky', 'outside the spec', 'reviewed, fine', 'added', 'modified', 'signature', 'removed', 'untouched']) {
    await expect(legend).toContainText(label);
  }

  // A verdict filter dims the rest of the city and clears again.
  await verdicts.getByTestId('filter-verdict-eyes').click();
  await waitForFilters(page, 'verdict=eyes;type=;rule=');
  await types.getByTestId('filter-clear').click();
  await waitForFilters(page, 'verdict=;type=;rule=');
}

async function waitForFilters(page: Page, value: string): Promise<void> {
  await expect(page.getByTestId('city')).toHaveAttribute('data-filters', value, { timeout: 30_000 });
}

async function labelsAndTooltip(page: Page, tracked: TrackedChange, report: Report): Promise<void> {
  const stats = tracked.change.stats;
  if (stats === null) throw new Error('the change has no stats');
  const files = report.packages.flatMap((pkg) => pkg.files);
  // One roof label per touched file; the verdict tag is the label's class and text.
  await sceneExpect(page.getByTestId('roof-label')).toHaveCount(files.filter((file) => file.status !== 'same').length);
  await expect(page.locator('[data-testid="roof-label"].v-eyes')).toHaveCount(stats.filesByVerdict.eyes);
  await expect(page.locator('[data-testid="roof-label"].v-ok')).toHaveCount(stats.filesByVerdict.ok);
  const eyes = files.find((file) => file.verdict === 'eyes');
  if (eyes === undefined) throw new Error('no file needs eyes');
  await expect(page.locator('[data-testid="roof-label"].v-eyes').filter({ hasText: baseName(eyes.id) })).toHaveCount(1);
  await expect(page.locator('[data-testid="roof-label"].v-eyes').first()).toContainText('Needs your eyes');

  // Tooltip: hover the building the first label names.
  const point = await project(page, eyes.id);
  await page.mouse.move(point.x, point.y, { steps: 6 });
  await waitForCityAttribute(page, 'data-hovered', await hoveredOrFile(page, eyes.id));
  const hit = (await hovered(page)) ?? eyes.id;
  const hitFile = files.find((file) => file.id === hit);
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip.getByTestId('tip-file')).toHaveText(baseName(hit));
  await expect(tip.getByTestId('tip-package')).toHaveText(report.packages.find((pkg) => pkg.files.some((file) => file.id === hit))?.path ?? '');
  if (hitFile !== undefined) {
    const label = VERDICTS.find(([key]) => key === hitFile.verdict)?.[1];
    if (label !== undefined) await expect(tip.getByTestId('tip-verdict')).toHaveText(label);
  }
  for (const word of ['added', 'modified', 'sig', 'removed']) await expect(tip.getByTestId('tip-counts')).toContainText(word);
  await page.mouse.move(2, 2);
  await waitForCityAttribute(page, 'data-hovered', '');
}

/** The id the pointer is over once the move has landed: the file itself unless another building sits in front of it. */
async function hoveredOrFile(page: Page, fallback: string): Promise<string> {
  await expect.poll(async () => (await hovered(page)) ?? '', { timeout: 30_000 }).not.toBe('');
  return (await hovered(page)) ?? fallback;
}

async function selectionAndFileView(page: Page, base: string, tracked: TrackedChange, report: Report): Promise<void> {
  const eyes = report.packages.flatMap((pkg) => pkg.files).find((file) => file.verdict === 'eyes');
  if (eyes === undefined) throw new Error('no file needs eyes');
  const point = await project(page, eyes.id);
  await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId('city')).not.toHaveAttribute('data-selected', '', { timeout: 30_000 });
  const picked = (await page.getByTestId('city').getAttribute('data-selected')) ?? '';

  const card = page.getByTestId('selection-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('card-file')).toHaveText(picked);
  await expect(card.getByTestId('card-counts')).toContainText('added');
  await expect(card.getByTestId('mark-checked')).toBeVisible();

  // The file view shows the diff the daemon computed for that file.
  const view = page.getByTestId('file-view');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('file-view-file')).toHaveText(picked);
  const diff = await getJson<FileDiff>(`${base}/api/changes/${String(tracked.change.id)}/diff?path=${encodeURIComponent(picked)}`);
  await expect(page.getByTestId('diff-view')).toHaveAttribute('data-state', diff.kind);
  if (diff.kind === 'text') {
    expect(diff.stats.added + diff.stats.removed).toBeGreaterThan(0);
    await expect(page.getByTestId('diff-stats')).toHaveText(`+${String(diff.stats.added)} −${String(diff.stats.removed)}`);
    await expect(page.locator('[data-testid="diff-row"][data-kind="add"]').first()).toBeAttached();
    await expect(page.getByTestId('hunk-counter')).toHaveText(new RegExp(`^\\d+ / ${String(diff.hunks?.length ?? 0)}$`));
  }
  // Esc leaves the selection and the panel returns to its tabs.
  await page.keyboard.press('Escape');
  await waitForCityAttribute(page, 'data-selected', '');
  await expect(page.getByTestId('reading-panel')).toBeVisible();
  await expect(page.getByTestId('file-view')).toBeHidden();
}

async function panelTabs(page: Page, report: Report): Promise<void> {
  const panel = page.getByTestId('reading-panel');
  await expect(panel.getByRole('heading', { name: 'Reading path' })).toBeVisible();
  const symbols = report.packages.flatMap((pkg) => pkg.files).flatMap((file) => file.symbols).filter((symbol) => symbol.status !== 'same').length;
  await expect(page.getByTestId('tab-order')).toHaveText(`Execution order${String(report.steps.length)}`);
  await expect(page.getByTestId('tab-findings')).toHaveText(`Findings${String(report.findings.length)}`);
  await expect(page.getByTestId('tab-outside')).toContainText('Outside the spec');
  await expect(page.getByTestId('tab-symbols')).toHaveText(`Symbols${String(symbols)}`);
  // The execution path is computed with the snapshot (ADR-034): the panel counts its stops.
  const stops = report.steps.length;
  const onPath = report.steps.every((one) => (one.section ?? 'path') === 'path');
  const count = `${String(stops)} ${stops === 1 ? 'stop' : 'stops'}`;
  await expect(panel.getByTestId('panel-summary')).toHaveText(
    stops > 0 ? `${count}, ${onPath ? 'in the order the code runs' : 'in reading order'}` : 'No execution path',
  );
}

const SECTION_LABELS: Record<ReviewedStep[0], [label: string, note: string]> = {
  path: ['Execution path', 'From each entry point, in the order the code runs'],
  migration: ['Migrations', 'Touched SQL migrations, read after the execution path'],
  unconnected: ['Unconnected', 'Touched symbols no entry point reaches'],
};

/** The name a stop card shows: the symbol id after `#`. */
const symbolName = (symbolId: string): string => symbolId.slice(symbolId.indexOf('#') + 1);

async function readingPath(page: Page, name: GoldenName, report: Report): Promise<void> {
  const expected = reviewed[name]?.path;
  if (expected === undefined) throw new Error(`no reviewed path for ${name}`);
  // The daemon's steps are the reviewed ones, in order: section, symbol and why.
  const ordered = [...report.steps].sort((a, b) => a.order - b.order);
  expect(ordered.map((one) => [one.section ?? 'path', one.symbolId, one.why])).toEqual(expected.map(([section, symbolId, , why]) => [section, symbolId, why]));

  await page.getByTestId('tab-order').click();
  const sections = [...new Set(expected.map(([section]) => section))];
  await expect(stopSections(page)).toHaveCount(sections.length);
  await expect(stopSections(page).getByTestId('section-label')).toHaveText(sections.map((section) => SECTION_LABELS[section][0]));
  await expect(stopSections(page).getByTestId('section-note')).toHaveText(sections.map((section) => SECTION_LABELS[section][1]));
  for (const section of sections) {
    const rows = expected.filter(([id]) => id === section);
    const cards = stopSection(page, section).getByTestId('stop-card');
    await expect(cards).toHaveCount(rows.length);
    await expect(stopSection(page, section).getByTestId('section-count')).toHaveText(String(rows.length));
    await expect(cards.getByTestId('stop-symbol')).toHaveText(rows.map(([, symbolId]) => symbolName(symbolId)));
    await expect(cards.getByTestId('stop-why')).toHaveText(rows.map(([, , , why]) => why));
    const symbols = await Promise.all((await cards.all()).map((card) => card.getAttribute('data-symbol')));
    expect(symbols).toEqual(rows.map(([, symbolId]) => symbolId));
  }
  // The inline diff: a card shows the step's own lines when the step has any, and no code block otherwise.
  const withDiff = ordered.filter((one) => one.diff.length > 0);
  expect(withDiff.length, `${name}: steps with an inline diff`).toBeGreaterThan(0);
  await expect(page.getByTestId('reading-panel').getByTestId('step-diff')).toHaveCount(withDiff.length);
  for (const one of withDiff) await expectInlineDiff(page, one);
}

async function expectInlineDiff(page: Page, one: Step): Promise<void> {
  const block = page.locator(`[data-testid="stop-card"][data-symbol="${one.symbolId}"]`).getByTestId('step-diff');
  await expect(block).toHaveCount(1);
  await expect(block.locator('.l')).toHaveCount(one.diff.length);
  const changed = one.diff.find((line) => line.kind !== 'ctx' && line.text.trim() !== '');
  if (changed !== undefined) await expect(block).toContainText(changed.text.trim());
}
