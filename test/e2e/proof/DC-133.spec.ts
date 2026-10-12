// Proof video for DC-133 (phase 4 T11): spec scope (SPEC.md 5.5, ADR-035)
// against the real daemon from dist/, in a temporary home, on an invented
// kite-shop repo. The branch touches a route file, a service, a db file and an
// unrelated banner. `.diffcity/spec.md` names the route string, the handler in
// backticks and links the service: the banner is outside the spec, labelled so
// in the city and listed in the Outside the spec tab. A prose-only spec marks
// nothing and shows the notice; a spec above 256 KiB is ignored with a notice.
// Recorded by `npm run proof -- DC-133`.

import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { createRepo, type FileTree } from '../../helpers/repo.js';
import { cli, getJson, stubEnv, until } from '../support/change-daemon.js';
import { criterion, expect, test, titleCard } from '../support/proof.js';
import { waitForCityAttribute, waitReady } from '../support/scene.js';

const BANNER = 'src/banner.ts';
const SPEC = '.diffcity/spec.md';
const ROUTER = `interface Router {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}
`;

const BASE: FileTree = {
  'src/routes.ts': `import { flyKite } from './service';\n\n${ROUTER}\nexport function registerRoutes(router: Router): void {\n  router.get('/kites/:id', flyKite);\n}\n`,
  'src/service.ts': `import { loadKite } from './db';\n\nexport function flyKite(id: string): string {\n  return loadKite(id);\n}\n`,
  'src/db.ts': `export function loadKite(id: string): string {\n  return 'kite-' + id;\n}\n`,
  [BANNER]: `export function bannerText(): string {\n  return 'Welcome';\n}\n`,
};

const TETHER: FileTree = {
  'src/routes.ts': `import { flyKite, tetherKite } from './service';\n\n${ROUTER}\nexport function registerRoutes(router: Router): void {\n  router.get('/kites/:id', flyKite);\n  router.post('/kites/:id/tether', tetherKite);\n}\n`,
  'src/service.ts': `import { loadKite, saveTether } from './db';\n\nexport function flyKite(id: string): string {\n  return loadKite(id);\n}\n\nexport function tetherKite(id: string): string {\n  return saveTether(id);\n}\n`,
  'src/db.ts': `export function loadKite(id: string): string {\n  return 'kite-' + id;\n}\n\nexport function saveTether(id: string): string {\n  return 'tether-' + id;\n}\n`,
  [BANNER]: `export function bannerText(): string {\n  return 'Welcome to the kite shop';\n}\n`,
  [SPEC]: '# Tether a kite\n\nAdd `POST /kites/:id/tether`. The handler is `tetherKite()` and the tether\nis stored by the db layer. See [the service](../src/service.ts#L3).\n',
};

const PROSE = 'Tether the kite with the service and the db layer, then refresh the banner.\n';
const NO_ROOT = 'The spec names no touched symbol or file';
const TOO_LARGE = 'The spec is larger than 256 KiB and was ignored';

const inSpecByPath = (report: Report): Record<string, boolean | null> =>
  Object.fromEntries(report.packages.flatMap((pkg) => pkg.files).map((file) => [file.path, file.inSpec]));

test('DC-133: files outside the spec are marked in the city and listed in the Outside the spec tab', async ({ page, proof }) => {
  test.setTimeout(300_000);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await titleCard(page, 'DC-133: spec scope (SPEC.md 5.5, ADR-035)', [
    'The real daemon from dist/, in a temporary home, on an invented kite-shop repo.',
    'The branch touches routes.ts, service.ts, db.ts and an unrelated banner.ts.',
    '.diffcity/spec.md names POST /kites/:id/tether, `tetherKite()` and links ../src/service.ts.',
  ]);

  const repo = await createRepo({ name: 'kite-shop', files: BASE, message: 'kite shop' });
  proof.onTeardown(() => repo.cleanup());
  await repo.branch('feature/tether-kites');
  await repo.commit('feat: tether kites', TETHER);

  const env = await stubEnv(proof);
  await proof.startDaemon(env);
  await cli(['track', repo.dir], env);
  const base = proof.baseURL;
  const repoId = await until(async () => (await getJson<RepoSummary[]>(`${base}/api/repos`)).find((r) => r.name === 'kite-shop')?.id, 60_000, 'kite-shop in /api/repos');
  const change = await until(
    async () => (await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`)).changes.find((c) => c.ref.endsWith('feature/tether-kites') && c.stats !== null),
    60_000,
    'the tether-kites change',
  );
  const reportUrl = `${base}/api/changes/${String(change.id)}/report`;
  const report = (): Promise<Report> => getJson<Report>(reportUrl);
  const roof = page.locator(`[data-testid="roof-label"][data-building="${BANNER}"]`);
  const outsideTab = page.getByTestId('tab-outside');

  await criterion(page, '1. The Report: routes, service and db are in the spec; the banner is not (verdict spec)', async () => {
    const first = await report();
    expect(inSpecByPath(first)).toMatchObject({ 'src/routes.ts': true, 'src/service.ts': true, 'src/db.ts': true, [BANNER]: false });
    expect(first.packages.flatMap((pkg) => pkg.files).find((file) => file.path === BANNER)?.verdict).toBe('spec');
    expect(first.specNotice).toBeUndefined();
    await page.goto(`${base}/?scene-debug#/change/${String(change.id)}`);
    await waitReady(page);
  }, 'GET /api/changes/:id/report from the daemon');

  await criterion(page, '2. The city labels banner.ts "Outside the spec"', async () => {
    await expect(roof).toHaveClass(/\bv-spec\b/);
    await expect(roof).toContainText('Outside the spec');
    await expect(page.locator('[data-testid="roof-label"].v-spec')).toHaveCount(1);
  }, BANNER);

  await criterion(page, '3. The Outside the spec tab lists banner.ts; a click selects its building', async () => {
    await expect(outsideTab).toHaveText('Outside the spec1');
    await outsideTab.click();
    const files = page.getByTestId('outside-file');
    await expect(files).toHaveCount(1);
    await expect(files.first()).toContainText(BANNER);
    await files.first().getByTestId('group-file').click();
    await waitForCityAttribute(page, 'data-selected', BANNER);
  }, 'connected to a root through call edges: in; not connected: out');

  await criterion(page, '4. A prose-only spec names nothing: the notice, nothing marked', async () => {
    await repo.commit('docs: prose spec', { [SPEC]: PROSE });
    await expect(page.getByTestId('empty-outside')).toHaveText(NO_ROOT, { timeout: 60_000 });
    await expect(outsideTab).toHaveText('Outside the spec0');
    await expect(page.locator('[data-testid="roof-label"].v-spec')).toHaveCount(0);
    expect(Object.values(inSpecByPath(await report())).every((value) => value === null)).toBe(true);
  }, 'prose words never match a symbol');

  await criterion(page, '5. A spec above 256 KiB is ignored, with a notice', async () => {
    let big = '`tetherKite`\n';
    while (big.length < 300 * 1024) big += 'A line of prose about kites and their tethers.\n';
    await repo.commit('docs: a very long spec', { [SPEC]: big });
    await expect(page.getByTestId('empty-outside')).toHaveText(TOO_LARGE, { timeout: 60_000 });
    await expect(page.locator('[data-testid="roof-label"].v-spec')).toHaveCount(0);
  }, '300 KiB .diffcity/spec.md');
});
