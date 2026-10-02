// Ways around repo trust (ADR-030, DC-53) that the daemon must not allow: a
// linked worktree that brings its own diffcity.config.js, a symlink to the repo
// under another name, and a settings.json that is corrupted while the daemon
// runs. Every config here leaves a marker when imported and then calls
// process.exit, so an import shows up both as a marker and as a dead test.

import { access, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrust } from '../../../src/cli/trust.js';
import type { RepoSummary } from '../../../src/core/model/types.js';
import { CONFIG_NOT_TRUSTED_NOTE } from '../../../src/core/settings/index.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

/** Leaves a marker when imported; when `exit`, then tries to take the process down. */
function hostileConfig(marker: string, exit: boolean): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(marker)}, 'imported\\n');`,
    ...(exit ? ['process.exit(42);'] : []),
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
  expect(response.status).toBe(200);
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

const scratch: string[] = [];
async function scratchDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dc-trust-attack-')));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop() ?? '', { recursive: true, force: true });
});

describe('collect/config-trust attacks (ADR-030, DC-53)', () => {
  it('trust/linked-worktree: a linked worktree of an untrusted repo, with its own config, gets no import', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const outside = await scratchDir();
    const rootMarker = join(outside, 'root-config.marker');
    const treeMarker = join(outside, 'tree-config.marker');
    const repo = await sampleRepo({ files: { 'diffcity.config.js': hostileConfig(rootMarker, true), 'README.md': '# sample-shop\n' } });
    const linked = join(outside, 'sample-shop-agent');
    await repo.git('worktree', 'add', '--quiet', '-b', 'agent/cart', linked);
    // The linked tree replaces the config with its own, committed and then edited again uncommitted.
    await writeFile(join(linked, 'diffcity.config.js'), hostileConfig(treeMarker, true));
    await writeFile(join(linked, 'agent.ts'), 'export const agent = 1;\n');
    await repo.git('-C', linked, 'add', '-A');
    await repo.git('-C', linked, 'commit', '--quiet', '-m', 'agent config');
    const repoId = await collect(test, linked);
    await writeFile(join(linked, 'diffcity.config.js'), `${hostileConfig(treeMarker, true)}// edited\n`);
    expect(await collect(test, linked)).toBe(repoId);
    expect(await collect(test, repo.dir)).toBe(repoId);

    expect(await exists(rootMarker)).toBe(false);
    expect(await exists(treeMarker)).toBe(false);
    expect(test.collection.db().repos.get(repoId)?.collectError).toBeNull();
    expect(await repoSummary(test, repoId)).toMatchObject({ error: null, notes: [CONFIG_NOT_TRUSTED_NOTE] });
    // The linked tree's change was collected, with the default tier 1 zones.
    const changes = test.collection.db().changes.listLive(repoId);
    expect(changes.some((change) => change.worktreePath === linked)).toBe(true);
  });

  it('trust/symlink-same-decision: a repo tracked through a symlink gets the trust of its realpath', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const outside = await scratchDir();
    const marker = join(outside, 'config.marker');
    const repo = await sampleRepo({ files: { 'diffcity.config.js': hostileConfig(marker, false), 'README.md': '# sample-shop\n' } });
    const alias = join(outside, 'other-name');
    await symlink(await realpath(repo.dir), alias);

    // Untrusted, through the symlink: no import, the note, the same repo as the real path.
    const viaAlias = await collect(test, alias);
    expect(await collect(test, repo.dir)).toBe(viaAlias);
    expect(await exists(marker)).toBe(false);
    expect((await repoSummary(test, viaAlias))?.notes).toEqual([CONFIG_NOT_TRUSTED_NOTE]);

    // Trusted by its real path, tracked through the symlink: imported.
    await trust(test, repo.dir);
    await collect(test, alias);
    expect(await exists(marker)).toBe(true);
    expect((await repoSummary(test, viaAlias))?.notes).toEqual([]);

    // Untrusted through the symlink: no import on an edited config.
    await trust(test, alias, true);
    await rm(marker);
    await repo.write({ 'diffcity.config.js': `${hostileConfig(marker, false)}// edited\n` });
    await collect(test, alias);
    expect(await exists(marker)).toBe(false);
    expect((await repoSummary(test, viaAlias))?.notes).toEqual([CONFIG_NOT_TRUSTED_NOTE]);
  });

  it('trust/corrupt-settings-live: a settings.json corrupted while the daemon runs trusts nothing, and the daemon keeps collecting', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const outside = await scratchDir();
    const marker = join(outside, 'config.marker');
    const repo = await sampleRepo({ files: { 'diffcity.config.js': hostileConfig(marker, false), 'README.md': '# sample-shop\n' } });
    await trust(test, repo.dir);
    const repoId = await collect(test, repo.dir);
    expect(await exists(marker)).toBe(true);

    const settings = join(test.home.env.DIFFCITY_HOME ?? '', 'settings.json');
    const corruptions = [
      '{"v":1,"trustedRepos":["' + (await realpath(repo.dir)),
      '[]',
      '{"v":1,"trustedRepos":"/"}',
      '{"v":2,"trustedRepos":[]}',
    ];
    for (const [index, text] of corruptions.entries()) {
      await rm(marker, { force: true });
      await writeFile(settings, text);
      await repo.write({ 'diffcity.config.js': `${hostileConfig(marker, false)}// edit ${String(index)}\n` });
      await collect(test, repo.dir);
      expect(await exists(marker), text).toBe(false);
      expect(test.collection.db().repos.get(repoId)?.collectError).toBeNull();
      expect(await repoSummary(test, repoId)).toMatchObject({ error: null, notes: [CONFIG_NOT_TRUSTED_NOTE] });
    }

    // Fixed by hand: trusted again on the next collection, no restart.
    await writeFile(settings, JSON.stringify({ v: 1, trustedRepos: [await realpath(repo.dir)] }));
    await repo.write({ 'diffcity.config.js': `${hostileConfig(marker, false)}// fixed\n` });
    await collect(test, repo.dir);
    expect(await exists(marker)).toBe(true);
    expect((await repoSummary(test, repoId))?.notes).toEqual([]);
  });
});
