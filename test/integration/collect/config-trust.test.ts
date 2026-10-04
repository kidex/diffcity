// A repo's diffcity.config.js runs only once the repo is trusted (ADR-024,
// ADR-030, DC-53). The shell hook tracks every repo on `cd`, so the daemon must
// not import the config of a repo nobody vouched for: the collector, the
// snapshot worker and base detection all use the defaults until `diffcity
// trust` lists the repo root in settings.json, which the next collection sees
// without a restart. Meanwhile the repo carries a note in GET /api/repos.

import { access, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTrust } from '../../../src/cli/trust.js';
import type { ChangeSummary, RepoSummary } from '../../../src/core/model/types.js';
import { CONFIG_NOT_TRUSTED_NOTE } from '../../../src/core/settings/index.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

/** A config that leaves a marker behind whenever it is imported, and moves the tier 1 zones to `cart`. */
function markingConfig(marker: string): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, 'imported\\n');`,
    "export default { tier1: ['cart'] };",
    '',
  ].join('\n');
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function repoSummary(test: TestDaemon, repoId: number): Promise<RepoSummary | undefined> {
  const response = await fetch(`http://127.0.0.1:${String(test.daemon.info.port)}/api/repos`);
  const repos = (await response.json()) as RepoSummary[];
  return repos.find((repo) => repo.id === repoId);
}

async function trust(test: TestDaemon, dir: string, remove = false): Promise<void> {
  const errors: string[] = [];
  const code = await runTrust(dir, remove ? { remove: true } : {}, {
    io: { stdout: () => undefined, stderr: (text) => errors.push(text) },
    env: test.home.env,
    cwd: dir,
  });
  expect(errors).toEqual([]);
  expect(code).toBe(0);
}

async function collect(test: TestDaemon, dir: string): Promise<number> {
  const response = await test.track(dir);
  if (!response.ok) throw new Error(response.error);
  await test.idle();
  return response.repo.id;
}

describe('collect/config-trust (ADR-030)', () => {
  it('never imports an untrusted repo config, notes it, and imports it on the next collection after diffcity trust', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const marker = join(test.home.root, 'config-imported.marker');
    const repo = await sampleRepo();
    await repo.branch('feature/cart');
    await repo.commit('sum the cart', {
      'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n',
      'src/session/token.ts': 'export const token = "";\n',
    });
    await repo.checkout('main');
    await repo.commit('add the diffcity config', { 'diffcity.config.js': markingConfig(marker) });

    const repoId = await collect(test, repo.dir);
    expect(await exists(marker)).toBe(false);
    const db = test.collection.db();
    expect(db.repos.get(repoId)?.collectError).toBeNull();
    const untrusted = await repoSummary(test, repoId);
    expect(untrusted).toMatchObject({ error: null, notes: [CONFIG_NOT_TRUSTED_NOTE] });
    // The wire contract the UI words the note by (DC-67): a stable code beside the text.
    expect(untrusted?.notes).toEqual([{ code: 'config-not-trusted', text: expect.any(String) as string }]);
    const branch = (): ChangeSummary | undefined =>
      db.changes.listLiveSummaries(repoId).find((change) => change.ref === 'branch:feature/cart');
    // The default tier 1 zones: `session`, not the config's `cart`.
    expect(branch()?.stats?.tier1Files).toEqual(['src/session/token.ts']);

    await trust(test, repo.dir);
    // A new head, so the branch gets a new snapshot built with the config.
    await repo.checkout('feature/cart');
    await repo.commit('tidy the cart', { 'src/cart/line.ts': 'export const line = 1;\n' });
    await repo.checkout('main');
    await collect(test, repo.dir);
    expect(await exists(marker)).toBe(true);
    expect(await repoSummary(test, repoId)).toMatchObject({ error: null, notes: [] });
    expect(branch()?.stats?.tier1Files).toEqual(['src/cart/line.ts', 'src/cart/total.ts']);
  });

  it('a trusted repo that is untrusted again stops importing at its next collection', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const marker = join(test.home.root, 'config-imported.marker');
    const repo = await sampleRepo({ files: { 'diffcity.config.js': markingConfig(marker), 'README.md': '# sample-shop\n' } });
    await trust(test, repo.dir);
    const repoId = await collect(test, repo.dir);
    expect(await exists(marker)).toBe(true);
    expect((await repoSummary(test, repoId))?.notes).toEqual([]);

    await trust(test, repo.dir, true);
    await rm(marker);
    // Edited config: a trusted repo would import it again for the base.
    await repo.write({ 'diffcity.config.js': `${markingConfig(marker)}// edited\n` });
    await collect(test, repo.dir);
    expect(await exists(marker)).toBe(false);
    expect((await repoSummary(test, repoId))?.notes).toEqual([CONFIG_NOT_TRUSTED_NOTE]);
  });

  it('an untrusted repo without a config file has no note', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const repo = await sampleRepo();
    const repoId = await collect(test, await realpath(repo.dir));
    expect((await repoSummary(test, repoId))?.notes).toEqual([]);
  });
});
