// Proof video for DC-140 (phase 4 T22): the whole Claude Code loop against the
// real daemon from dist/, in a temporary DIFFCITY_HOME and CLAUDE_CONFIG_DIR,
// on the invented shopfront repo with an invented transcript. The built
// `setup-claude` writes the /diffcity-review command and the hooks; the video
// then runs the commands exactly as they were written: the Stop hook, the
// command's steps (`diff --json --compact`, `.diffcity/findings.json`,
// `import --open` with the browser opener stubbed), Ask agent to fix and the
// command taking the fix queue, the agent's fix and the second review that
// marks the finding fixed, and the SessionEnd hook.
// Recorded by `npm run proof -- DC-140`.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { transcript } from '../../helpers/transcript.js';
import { until } from '../support/change-daemon.js';
import { effects } from '../support/effects.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import {
  buildShopfront,
  collected,
  DISCOUNT,
  DISCOUNT_FIXED,
  loopEnv,
  realDir,
  runHook,
  SHOP_BRANCH,
  setupClaude,
  sh,
  TOTAL,
} from '../support/review-loop.js';
import { waitReady } from '../support/scene.js';

type FindingInput = Omit<Finding, 'id' | 'state' | 'symbolId' | 'sources'>;

const SESSION = '8e1f3a5c-2b7d-4c9e-a0f6-4d2b8c6e1a3f';
const HIGH_TITLE = 'Any unknown code is subtracted from the total as a number';
const FIXTURE = new URL('../../fixtures/code-review/shopfront-findings.json', import.meta.url);

const pins = async (page: Page): Promise<string[]> =>
  (await effects(page)).markers.filter((marker) => marker.kind === 'pin').map((marker) => `${marker.file.slice(marker.file.lastIndexOf('/') + 1)}:${String(marker.severity)}`).sort();

test('DC-140: the Claude Code review loop, end to end', async ({ page, proof }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-140: phase 4, the review loop end to end', [
    'The real daemon from dist/, a temporary DIFFCITY_HOME and CLAUDE_CONFIG_DIR, the invented shopfront repo.',
    'Every command runs as setup-claude wrote it: the Stop hook, /diffcity-review, the SessionEnd hook.',
    'No real claude, gh or browser opener: stubs on PATH.',
  ]);

  const loop = await loopEnv(proof);
  await proof.startDaemon(loop.env);
  const repo = await buildShopfront();
  proof.onTeardown(() => repo.cleanup());
  const dir = await realDir(repo);
  const setup = await setupClaude(loop, proof.root);
  const findings = JSON.parse(await readFile(FIXTURE, 'utf8')) as FindingInput[];

  // The agent's session: a prompt, an edit, a background reviewer.
  const project = join(loop.claude, 'projects', '-work-shopfront');
  await mkdir(project, { recursive: true });
  const transcriptPath = join(project, `${SESSION}.jsonl`);
  const main = transcript({ sessionId: SESSION, cwd: dir, branch: SHOP_BRANCH, start: new Date(Date.now() - 15 * 60_000).toISOString() });
  main.prompt('Apply a discount code to the cart total.');
  main.toolResult(main.toolCall('Write', { file_path: join(dir, DISCOUNT), content: '...' }), {}, 'ok');
  main.agent({ agentId: 'rev01', type: 'general-purpose', description: 'Review the discount code' });
  main.aiTitle('Discount codes in the cart');
  await writeFile(transcriptPath, main.jsonl());
  const hookInput = { sessionId: SESSION, transcriptPath, cwd: dir };

  /** The /diffcity-review steps after the queue: diff, findings.json, import --open; returns the opened URL. */
  const review = async (entries: FindingInput[]): Promise<{ diff: Report; imported: string; opened: string }> => {
    const diff = await sh(setup.steps.diff, repo.dir, loop.env);
    expect(diff.code, diff.stderr).toBe(0);
    await mkdir(join(repo.dir, '.diffcity'), { recursive: true });
    await writeFile(join(repo.dir, '.diffcity', 'findings.json'), `${JSON.stringify(entries, null, 2)}\n`);
    const imported = await sh(setup.steps.importOpen, repo.dir, loop.env);
    expect(imported.code, imported.stderr).toBe(0);
    return { diff: JSON.parse(diff.stdout) as Report, imported: imported.stdout.split('\n')[0] ?? '', opened: (await loop.opened()).at(-1) ?? '' };
  };

  await criterion(page, '1. diffcity setup-claude writes /diffcity-review and the Stop and SessionEnd hooks', async () => {
    expect(setup.stop).toContain('track --agent');
    expect(setup.sessionEnd).toBe(setup.stop);
    expect(await readFile(join(loop.claude, 'commands', 'diffcity-review.md'), 'utf8')).toContain('<!-- diffcity: diffcity-review v1 -->');
  },'hooks: <node> <dist/cli/index.js> track --agent; commands/diffcity-review.md');

  const stop = await runHook(setup.stop, 'Stop', hookInput, loop.env);
  expect(stop.code, stop.stderr).toBe(0);
  const change = await collected(proof, 'shopfront', SHOP_BRANCH);
  await until(async () => (await (await fetch(`${proof.baseURL}/api/changes/${String(change.changeId)}/sessions`)).json() as { sessions: { digest: unknown }[] }).sessions[0]?.digest ?? undefined, 60_000, 'the session read');

  await criterion(page, '2. The Stop hook: the change is collected and the Session tab shows the running session', async () => {
    await page.goto(change.url);
    await waitReady(page);
    await page.getByTestId('tab-session').click();
    const card = page.getByTestId('session-card');
    await expect(card.getByTestId('session-title')).toHaveText('Discount codes in the cart');
    await expect(card.getByTestId('session-active')).toHaveText('active');
    await expect(card.getByTestId('run-status')).toHaveText(['running']);
  }, 'Stop hook JSON on stdin: session_id, transcript_path, cwd, hook_event_name');

  const first = await review(findings);
  await criterion(page, '3. /diffcity-review: diff --json --compact, findings.json, import --open; pins and the risky outline', async () => {
    expect(first.opened).toBe(`${proof.baseURL}/#/change/${String(change.changeId)}`);
    await page.goto(first.opened.replace('/#/', '/?scene-debug#/'));
    await waitReady(page);
    await expect(page.locator(`.roof.v-risky[data-building="${DISCOUNT}"]`)).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => pins(page), { timeout: 30_000 }).toEqual(['discount.ts:high', 'total.ts:med']);
  }, `${first.imported}; the opener stub got ${first.opened}`);

  const high = await until(async () => (await change.report()).findings.find((finding) => finding.title === HIGH_TITLE), 30_000, 'the high finding');
  const queue = join(repo.dir, '.diffcity', 'fix-queue');
  await criterion(page, '4. Ask agent to fix: the daemon writes .diffcity/fix-queue/<id>.json', async () => {
    await page.getByTestId('tab-findings').click();
    const card = page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${high.id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.getByTestId('finding-ask').click();
    await expect(card.getByTestId('finding-ask')).toHaveText('Queued');
    expect(await readdir(queue)).toHaveLength(1);
  }, `fix-queue/<sha256(${high.id}) 32 hex>.json: key, file, line, severity, title, message, fix, queuedAt`);

  const take = await sh(setup.steps.take, repo.dir, loop.env);
  expect(take.code, take.stderr).toBe(0);
  const items = await readdir(join(repo.dir, '.diffcity', 'fix-queue.taking'));
  const item = JSON.parse(await readFile(join(repo.dir, '.diffcity', 'fix-queue.taking', items[0] ?? ''), 'utf8')) as { title: string };
  expect(item.title).toBe(HIGH_TITLE);
  expect((await sh(setup.steps.drop, repo.dir, loop.env)).code).toBe(0);
  const fixedHead = await repo.commit('return the sum for an unknown code', { [DISCOUNT]: DISCOUNT_FIXED });
  await until(async () => ((await change.report()).meta.head === fixedHead ? true : undefined), 60_000, 'the fixed head collected');
  const second = await review(findings.filter((finding) => finding.title !== HIGH_TITLE));

  await criterion(page, '5. The agent took the queue and fixed it; the second review marks the finding fixed', async () => {
    await page.goto('about:blank');
    await page.goto(second.opened.replace('/#/', '/?scene-debug#/'));
    await waitReady(page);
    await expect.poll(() => pins(page), { timeout: 30_000 }).toEqual(['total.ts:med']);
    await expect(page.locator(`.roof.v-risky[data-building="${DISCOUNT}"]`)).toHaveCount(0);
    await page.getByTestId('tab-findings').click();
    await expect(page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${high.id}"]`)).toHaveAttribute('data-state', 'fixed');
    // diffcity's own files are not part of the change.
    expect((await change.report()).packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same').map((file) => file.id).sort()).toEqual([DISCOUNT, TOTAL]);
  }, `${second.imported}; .diffcity/ is never a file of the change`);

  await criterion(page, '6. The SessionEnd hook: the active tag goes, the reviewer with no outcome reads unknown', async () => {
    await page.getByTestId('tab-session').click();
    const card = page.getByTestId('session-card');
    await expect(card.getByTestId('session-active')).toHaveText('active');
    const end = await runHook(setup.sessionEnd, 'SessionEnd', hookInput, loop.env);
    expect(end.code, end.stderr).toBe(0);
    await expect(card.getByTestId('session-active')).toHaveCount(0, { timeout: 60_000 });
    await expect(card.getByTestId('run-status')).toHaveText(['unknown'], { timeout: 60_000 });
  }, 'SessionEnd hook JSON: hook_event_name SessionEnd, reason prompt_input_exit');
});
