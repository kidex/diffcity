// e2e/code-review (SPEC.md section 7.1, 5.6 and 3a, phase 4 exit criterion):
// the review loop end to end against the real daemon from dist/, in a
// temporary DIFFCITY_HOME and CLAUDE_CONFIG_DIR, on the invented shopfront
// repo. The built `setup-claude` writes the /diffcity-review command and the
// hooks; the spec then runs the command's documented steps as Claude Code
// would, with the commands exactly as the command file spells them: `diff
// --json --compact`, the findings written to `.diffcity/findings.json`, and
// `import .diffcity/findings.json --open` with the browser opener stubbed. The
// page opens the URL the opener was given and touches nothing.
//
// - setup-then-import-puts-pins-on-city: the city shows the pins and the
//   risky outline straight away;
// - second-import-marks-fixed: the agent fixes the high finding, the second
//   review no longer reports it, the import marks it fixed;
// - fix-queue-round-trip: Ask agent to fix writes `.diffcity/fix-queue/<id>.json`
//   (SPEC.md section 6) with the version 1 item, and the command's take steps
//   consume it;
// - own-files-not-in-change: findings.json and the fix queue never become
//   files of the change, in the Report, in `diff --json` or on the city.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { RepoDetail } from '../../../src/core/model/types.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import type { TempRepo } from '../../helpers/repo.js';
import { getJson, until } from '../support/change-daemon.js';
import { effects } from '../support/effects.js';
import { expect, test, type ProofWorld } from '../support/proof.js';
import {
  absoluteCli,
  buildShopfront,
  cliRun,
  collected,
  DISCOUNT,
  DISCOUNT_FIXED,
  FORMAT,
  fileIds,
  loopEnv,
  SHOP_BRANCH,
  setupClaude,
  sh,
  TOTAL,
  type ClaudeSetup,
  type Collected,
  type LoopEnv,
  type Run,
} from '../support/review-loop.js';
import { sceneExpect, waitReady } from '../support/scene.js';

type FindingInput = Omit<Finding, 'id' | 'state' | 'symbolId' | 'sources'>;

const FIXTURE = new URL('../../fixtures/code-review/shopfront-findings.json', import.meta.url);
const HIGH_TITLE = 'Any unknown code is subtracted from the total as a number';

interface Loop {
  loop: LoopEnv;
  repo: TempRepo;
  setup: ClaudeSetup;
  change: Collected;
}

const fixture = async (): Promise<FindingInput[]> => JSON.parse(await readFile(FIXTURE, 'utf8')) as FindingInput[];

/** The daemon, shopfront tracked, setup-claude run in the user's home. */
async function start(proof: ProofWorld): Promise<Loop> {
  const loop = await loopEnv(proof);
  await proof.startDaemon(loop.env);
  const repo = await buildShopfront();
  proof.onTeardown(() => repo.cleanup());
  const setup = await setupClaude(loop, proof.root);
  const tracked = await cliRun(['track', repo.dir], repo.dir, loop.env);
  expect(tracked.code, tracked.stderr).toBe(0);
  return { loop, repo, setup, change: await collected(proof, 'shopfront', SHOP_BRANCH) };
}

interface Review {
  diff: Report;
  imported: Run;
  /** The URL `import --open` handed to the browser opener. */
  opened: string;
}

/** The /diffcity-review steps after the fix queue: diff, write the findings, import and open. */
async function review(state: Loop, findings: FindingInput[]): Promise<Review> {
  const { repo, setup, loop } = state;
  const before = (await loop.opened()).length;
  const diffRun = await sh(setup.steps.diff, repo.dir, loop.env);
  expect(diffRun.code, diffRun.stderr).toBe(0);
  const diff = JSON.parse(diffRun.stdout) as Report;
  await mkdir(join(repo.dir, '.diffcity'), { recursive: true });
  await writeFile(join(repo.dir, '.diffcity', 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`);
  const imported = await sh(setup.steps.importOpen, repo.dir, loop.env);
  expect(imported.code, imported.stderr).toBe(0);
  const opened = await loop.opened();
  expect(opened).toHaveLength(before + 1);
  return { diff, imported, opened: opened.at(-1) ?? '' };
}

/** The opened URL with the scene's debug hook on, nothing else changed. */
const withDebug = (url: string): string => url.replace('/#/', '/?scene-debug#/');

const pins = async (page: Page): Promise<string[]> =>
  (await effects(page)).markers.filter((marker) => marker.kind === 'pin').map((marker) => `${marker.file}:${String(marker.severity)}`).sort();

const riskyLabel = (page: Page, file: string) => page.locator(`.roof.v-risky[data-building="${file}"]`);

const findingCard = (page: Page, id: string) => page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${id}"]`);

async function highFinding(change: Collected): Promise<Finding> {
  return until(async () => (await change.report()).findings.find((finding) => finding.title === HIGH_TITLE), 30_000, 'the imported high finding');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
});

test('code-review/setup-then-import-puts-pins-on-city', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const state = await start(proof);
  const { setup, change } = state;

  // setup-claude chose the built CLI (no global install on PATH) for the command file and both hooks.
  expect(setup.cli).toBe(absoluteCli());
  expect(setup.stop).toBe(`${absoluteCli()} track --agent`);
  expect(setup.sessionEnd).toBe(setup.stop);
  expect(setup.commandText).toContain('<!-- diffcity: diffcity-review v1 -->');
  expect(setup.steps.diff).toBe(`${absoluteCli()} diff --json --compact`);
  expect(setup.steps.importOpen).toBe(`${absoluteCli()} import .diffcity/findings.json --open`);

  const done = await review(state, await fixture());
  // diff --json --compact: the touched files only, with the Report's keys.
  expect(fileIds(done.diff).sort()).toEqual([DISCOUNT, TOTAL]);
  expect(Object.keys(done.diff).sort()).toEqual(expect.arrayContaining(['findings', 'meta', 'packages', 'steps', 'summary']));
  expect(done.diff.meta.repo).toBe('shopfront');
  expect(done.imported.stdout).toContain('Imported 2 findings into feature/discounts (0 merged, 0 skipped, 0 fixed)');
  expect(done.opened).toBe(`${proof.baseURL}/#/change/${String(change.changeId)}`);

  // The page opens what the opener was given; no click, no tab, no reload.
  await page.goto(withDebug(done.opened));
  await waitReady(page);
  await sceneExpect(riskyLabel(page, DISCOUNT)).toHaveCount(1);
  await expect(riskyLabel(page, DISCOUNT)).toContainText('Risky');
  await expect(riskyLabel(page, TOTAL)).toHaveCount(0);
  await expect.poll(() => pins(page), { timeout: 30_000 }).toEqual([`${DISCOUNT}:high`, `${TOTAL}:med`]);
  await expect(page.getByTestId('filter-verdict-risky')).toHaveText('Risky1');
  await expect(page.getByTestId('tab-findings')).toHaveText('Findings2');
});

test('code-review/second-import-marks-fixed', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const state = await start(proof);
  const { repo, change } = state;
  const findings = await fixture();
  await review(state, findings);
  const high = await highFinding(change);
  expect(high.state).toBe('open');

  // The agent fixes the high finding and commits; the daemon collects the new head.
  const fixedHead = await repo.commit('return the sum for an unknown code', { [DISCOUNT]: DISCOUNT_FIXED });
  await until(async () => ((await change.report()).meta.head === fixedHead ? true : undefined), 60_000, 'the snapshot of the fixed head');

  // The second review reports only the finding that is still there.
  const second = await review(state, findings.filter((finding) => finding.title !== HIGH_TITLE));
  // The finding still reported merges into the stored one; the one no longer reported, whose anchor changed, is fixed.
  expect(second.imported.stdout).toContain('Imported 1 finding into feature/discounts (1 merged, 0 skipped, 1 fixed)');
  const report = await change.report();
  expect(report.findings.find((finding) => finding.id === high.id)?.state).toBe('fixed');
  expect(report.findings.find((finding) => finding.file === TOTAL)?.state).toBe('open');
  expect(report.packages.flatMap((pkg) => pkg.files).find((file) => file.id === DISCOUNT)?.verdict).toBe('ok');

  await page.goto(withDebug(second.opened));
  await waitReady(page);
  await expect.poll(() => pins(page), { timeout: 30_000 }).toEqual([`${TOTAL}:med`]);
  await expect(riskyLabel(page, DISCOUNT)).toHaveCount(0);
  await expect(page.locator(`.roof.v-ok[data-building="${DISCOUNT}"]`)).toHaveCount(1);
  await page.getByTestId('tab-findings').click();
  await expect(findingCard(page, high.id)).toHaveAttribute('data-state', 'fixed');
  await expect(findingCard(page, high.id).getByTestId('finding-state')).toBeVisible();
});

test('code-review/fix-queue-round-trip', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const state = await start(proof);
  const { repo, setup, loop, change } = state;
  const done = await review(state, await fixture());
  const high = await highFinding(change);
  const input = (await fixture()).find((finding) => finding.title === HIGH_TITLE);
  if (input === undefined) throw new Error('the fixture lost its high finding');

  await page.goto(withDebug(done.opened));
  await waitReady(page);
  await page.getByTestId('tab-findings').click();
  const card = findingCard(page, high.id);
  await card.getByTestId('finding-ask').click();
  await expect(card.getByTestId('finding-ask')).toHaveText('Queued');

  // One file per item, named after the first 32 hex digits of the SHA-256 of the key, holding the item itself.
  const queue = join(repo.dir, '.diffcity', 'fix-queue');
  const name = `${createHash('sha256').update(high.id).digest('hex').slice(0, 32)}.json`;
  expect(await readdir(queue)).toEqual([name]);
  const item = JSON.parse(await readFile(join(queue, name), 'utf8')) as Record<string, unknown>;
  expect(item).toEqual({
    key: high.id,
    file: DISCOUNT,
    line: input.line,
    ...(item['symbol'] === undefined ? {} : { symbol: 'applyDiscount' }),
    severity: 'high',
    title: input.title,
    message: input.message,
    fix: input.fix,
    queuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
  });
  expect(Date.parse(String(item['queuedAt']))).toBeLessThanOrEqual(Date.now());
  // Asking again while the item is queued writes nothing new.
  expect(await readdir(queue)).toHaveLength(1);

  // The command's first steps: take the whole queue by renaming it, read every item, then drop it.
  const take = await sh(setup.steps.take, repo.dir, loop.env);
  expect(take.code, take.stderr).toBe(0);
  expect(existsSync(queue)).toBe(false);
  const taken = join(repo.dir, '.diffcity', 'fix-queue.taking');
  expect(await readdir(taken)).toEqual([name]);
  expect(JSON.parse(await readFile(join(taken, name), 'utf8'))).toEqual(item);
  const drop = await sh(setup.steps.drop, repo.dir, loop.env);
  expect(drop.code, drop.stderr).toBe(0);
  expect(existsSync(taken)).toBe(false);
  // With nothing queued the take step fails, which the command reads as "nothing is queued".
  expect((await sh(setup.steps.take, repo.dir, loop.env)).code).not.toBe(0);
});

test('code-review/own-files-not-in-change', async ({ proof, page }) => {
  test.setTimeout(180_000);
  const state = await start(proof);
  const { repo, setup, loop, change } = state;
  const done = await review(state, await fixture());
  const high = await highFinding(change);

  await page.goto(withDebug(done.opened));
  await waitReady(page);
  await page.getByTestId('tab-findings').click();
  await findingCard(page, high.id).getByTestId('finding-ask').click();
  await expect(findingCard(page, high.id).getByTestId('finding-ask')).toHaveText('Queued');
  // A take that stopped halfway leaves fix-queue.taking behind as well.
  await mkdir(join(repo.dir, '.diffcity', 'fix-queue.taking'), { recursive: true });
  await writeFile(join(repo.dir, '.diffcity', 'fix-queue.taking', `${'0'.repeat(32)}.json`), '{"key":"f:leftover"}\n');
  expect(await repo.status()).toContain('.diffcity/');

  // An agent edit next to them: the collection that picks it up has seen the own files too.
  await repo.write({ [FORMAT]: 'export function formatCents(cents: number): string {\n  return `${(cents / 100).toFixed(2)} EUR`;\n}\n' });
  expect((await cliRun(['track', repo.dir], repo.dir, loop.env)).code).toBe(0);
  const report = await until(
    async () => {
      const current = await change.report();
      return current.packages.flatMap((pkg) => pkg.files).find((file) => file.id === FORMAT)?.status === 'mod' ? current : undefined;
    },
    60_000,
    'the snapshot with the edit to format.ts',
  );

  const touched = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same').map((file) => file.id).sort();
  expect(touched).toEqual([DISCOUNT, FORMAT, TOTAL]);
  expect(fileIds(report).filter((id) => id.startsWith('.diffcity'))).toEqual([]);
  expect(report.summary.files).toBe(fileIds(report).length);
  // The findings stay on the change; no Draft appeared for the own files.
  expect(report.findings.map((finding) => finding.file).sort()).toEqual([DISCOUNT, TOTAL]);
  const detail = await getJson<RepoDetail>(`${proof.baseURL}/api/repos/${String(change.repoId)}`);
  expect(detail.changes.map((one) => one.ref)).toEqual([`branch:${SHOP_BRANCH}`]);

  const diffRun = await sh(setup.steps.diff, repo.dir, loop.env);
  expect(diffRun.code, diffRun.stderr).toBe(0);
  expect(fileIds(JSON.parse(diffRun.stdout) as Report).sort()).toEqual([DISCOUNT, FORMAT, TOTAL]);

  // The city has a building per Report file and no roof label for an own file.
  await page.reload();
  await waitReady(page);
  await sceneExpect(page.getByTestId('roof-label')).toHaveCount(3);
  const shown = await page.evaluate<Record<string, unknown>>('window.diffcityScene.shown()');
  expect(Object.keys(shown).sort()).toEqual(fileIds(report).sort());
  await expect(page.locator('[data-testid="roof-label"][data-building^=".diffcity"]')).toHaveCount(0);
});
