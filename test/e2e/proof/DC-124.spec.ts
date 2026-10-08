// Proof video for DC-124 (phase 4 T13): the layers rule (ADR-031) against the
// real daemon from dist/, in a temporary home, on the invented `acme-cli` repo.
// settings.json declares the layers [src/cli, src/ui] > [src/daemon] > [src/core].
// The branch adds an upward import (core → daemon), a horizontal one
// (cli → ui), a downward one (cli → core), a type-only upward one and a
// dynamic import() inside a function; store.ts keeps an upward import that
// main already had. The city draws an X on the roof of each importer, on the
// function's floor for the dynamic import, and none on store.ts; the chip
// counts 4 violations. allowTypeImports drops the type-only one; Mark as
// intended sticks on a new commit; useTsconfigPaths without a tsconfig.json
// says so in the check's reason.
// Recorded by `npm run proof -- DC-124`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Report } from '../../../src/core/report/types.js';
import { createRepo } from '../../helpers/repo.js';
import { cli, getJson, stubEnv, until } from '../support/change-daemon.js';
import { effects } from '../support/effects.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitReady } from '../support/scene.js';

const BRANCH = 'agent/layers';
const RUN = 'src/cli/run.ts';
const LEDGER = 'src/core/ledger.ts';
const TYPES = 'src/core/types.ts';
const STORE = 'src/core/store.ts';
const SERVER = 'src/daemon/server.ts';

const main: Record<string, string> = {
  'README.md': '# acme-cli\n',
  [LEDGER]: 'export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n',
  [STORE]: "import { listen } from '../daemon/server.js';\n\nexport function save(key: string): string {\n  return key + String(listen.length);\n}\n",
  [TYPES]: 'export interface Entry {\n  id: string;\n}\n',
  'src/daemon/queue.ts': 'export interface Job {\n  id: string;\n}\n\nexport function enqueue(job: Job): Job {\n  return job;\n}\n',
  [SERVER]: 'export function listen(port: number): number {\n  return port;\n}\n\nexport function close(): void {\n  return;\n}\n',
  [RUN]: 'export function run(argv: string[]): number {\n  return argv.length;\n}\n',
  'src/ui/panel.ts': "export function panel(): string {\n  return 'panel';\n}\n",
};

const branch: Record<string, string> = {
  [LEDGER]: "import { enqueue } from '../daemon/queue.js';\n\nexport function total(xs: number[]): number {\n  enqueue({ id: 'total' });\n  return xs.reduce((a, b) => a + b, 0);\n}\n",
  [STORE]: "import { listen } from '../daemon/server.js';\n\nexport function save(key: string): string {\n  return key + String(listen.length) + '!';\n}\n",
  [TYPES]: "import type { Job } from '../daemon/queue.js';\n\nexport interface Entry {\n  id: string;\n  job?: Job;\n}\n",
  [RUN]: "import { panel } from '../ui/panel.js';\nimport { total } from '../core/ledger.js';\n\nexport function run(argv: string[]): number {\n  return total([argv.length]) + panel().length;\n}\n",
  [SERVER]:
    "export function listen(port: number): number {\n  return port;\n}\n\nexport async function boot(argv: string[]): Promise<number> {\n  const cli = await import('../cli/run.js');\n  return cli.run(argv);\n}\n\nexport function close(): void {\n  return;\n}\n",
};

const ruleX = async (page: Page): Promise<string[]> =>
  (await effects(page)).markers
    .filter((marker) => marker.kind === 'x')
    .map((marker) => `${marker.file}@${marker.floor === null ? 'roof' : `floor ${String(marker.floor)}`}`)
    .sort();

test('DC-124: the layers rule marks the import edges a change adds, by layer', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-124: the layers rule (ADR-031)', [
    'The real daemon from dist/, in a temporary home, on the invented acme-cli repo.',
    'settings.json layers: [src/cli, src/ui] > [src/daemon] > [src/core].',
    'The branch adds upward, horizontal, downward, type-only and dynamic imports; store.ts keeps an old upward one.',
  ]);

  const repo = await createRepo({ name: 'acme-cli', files: main });
  proof.onTeardown(() => repo.cleanup());
  await repo.branch(BRANCH);
  await repo.commit('wire layers', branch);
  const settingsFile = join(proof.home, 'settings.json');
  const settings = (extra: Record<string, unknown>): string =>
    JSON.stringify({ v: 1, trustedRepos: [], rules: [{ id: 'layers', kind: 'layers', layers: [['src/cli', 'src/ui'], ['src/daemon'], ['src/core']], ...extra }] }, null, 2);
  await mkdir(proof.home, { recursive: true });
  await writeFile(settingsFile, settings({}));

  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const repoId = await until(async () => (await getJson<{ id: number; name: string }[]>(`${base}/api/repos`)).find((entry) => entry.name === 'acme-cli')?.id, 60_000, 'acme-cli in /api/repos');
  const change = await until(
    async () => (await getJson<{ changes: { id: number; ref: string; stats: unknown }[] }>(`${base}/api/repos/${String(repoId)}`)).changes.find((entry) => entry.ref.endsWith(BRANCH) && entry.stats !== null),
    60_000,
    'the agent/layers change with its first snapshot',
  );
  const reportUrl = `${base}/api/changes/${String(change.id)}/report`;
  const report = (): Promise<Report> => getJson<Report>(reportUrl);
  const chip = page.getByRole('list', { name: 'Rule checks' }).getByRole('listitem');
  const recollect = async (what: string, done: (next: Report) => boolean): Promise<void> => {
    await cli(['track', repo.dir], env);
    await until(async () => (done(await report()) ? true : undefined), 60_000, what);
    await page.reload();
    await waitReady(page);
  };

  const first = await report();
  const upward = first.findings.find((finding) => finding.file === LEDGER);
  if (upward === undefined) throw new Error('the upward finding on ledger.ts is missing');

  await criterion(page, '1. X on the roofs of the importers, on the boot floor for the dynamic import; store.ts has none', async () => {
    await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
    await waitReady(page);
    await expect(chip).toHaveText(['layers: 4 violations']);
    await expect.poll(() => ruleX(page)).toEqual([`${RUN}@roof`, `${LEDGER}@roof`, `${TYPES}@roof`, `${SERVER}@floor 1`]);
    expect(first.findings.map((finding) => finding.file)).not.toContain(STORE);
    expect(first.findings.map((finding) => finding.file)).toHaveLength(4);
  }, 'cli → ui horizontal, core → daemon upward (value and type-only), daemon → cli dynamic; cli → core passes');

  await criterion(page, '2. The finding says which import, which modules and layers, and what is allowed', async () => {
    await page.getByTestId('tab-findings').click();
    const body = page.getByTestId('tab-findings-body');
    await expect(body.locator(`[data-testid="finding"][data-finding="${upward.id}"]`)).toContainText('Upward import: src/core → src/daemon');
    await expect(body.locator(`[data-testid="finding"][data-finding="${upward.id}"]`)).toContainText("Import '../daemon/queue.js' goes from src/core (layer 2) to src/daemon (layer 1). Allowed: imports to a lower layer.");
    await expect(body.getByTestId('finding').filter({ hasText: 'Horizontal import: src/cli → src/ui' })).toHaveCount(1);
    expect(upward.category).toBe('architecture');
    expect(upward.severity).toBe('med');
    expect(upward.line).toBe(1);
  }, `${upward.title}, med architecture, line 1`);

  await criterion(page, '3. Mark as intended: the X leaves ledger.ts and stays gone after a new commit', async () => {
    const card = page.getByTestId('tab-findings-body').locator(`[data-testid="finding"][data-finding="${upward.id}"]`);
    await card.getByTestId('finding-intend').click();
    await expect(card).toHaveAttribute('data-state', 'intended');
    await expect.poll(() => ruleX(page)).toEqual([`${RUN}@roof`, `${TYPES}@roof`, `${SERVER}@floor 1`]);
    const head = await repo.commit('bump version', { [LEDGER]: `${branch[LEDGER] ?? ''}\nexport const VERSION = 2;\n` });
    await recollect('the snapshot of the new head', (next) => next.meta.head === head);
    expect((await report()).findings.find((finding) => finding.id === upward.id)?.state).toBe('intended');
    await expect.poll(() => ruleX(page)).toEqual([`${RUN}@roof`, `${TYPES}@roof`, `${SERVER}@floor 1`]);
  }, 'same finding id on the new head, state intended');

  await criterion(page, '4. allowTypeImports: true in settings.json: the type-only import is skipped', async () => {
    await writeFile(settingsFile, settings({ allowTypeImports: true }));
    await recollect('the check without the type-only finding', (next) => next.checks?.[0]?.findings === 3);
    await expect(chip).toHaveText(['layers: 3 violations']);
    await expect.poll(() => ruleX(page)).toEqual([`${RUN}@roof`, `${SERVER}@floor 1`]);
  }, 'types.ts no longer reported');

  await criterion(page, '5. useTsconfigPaths without a tsconfig.json: the check says so', async () => {
    await writeFile(settingsFile, settings({ allowTypeImports: true, useTsconfigPaths: true }));
    await recollect('the tsconfig reason', (next) => next.checks?.[0]?.reason === 'tsconfig.json not found');
    await expect(chip).toHaveAttribute('title', 'tsconfig.json not found');
    await expect(chip).toHaveText(['layers: 3 violations']);
  }, 'reason: tsconfig.json not found');
});
