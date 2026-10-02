// Fingerprints of a change (ADR-027) from buildReportWithHead over small temp repos.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReport, buildReportWithHead } from '../../../src/core/report/build.js';
import { computeSnapshot, contentHashOf } from '../../../src/core/report/snapshot.js';
import { ghForbidden, isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { buildScenario, listScenarios } from '../../helpers/scenario.js';

isolateGitConfig();

const repos: TempRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

const sha = (...parts: string[]): string => {
  const hash = createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest('hex');
};
const NOW = new Date('2026-03-04T05:06:07.000Z');

const TOTAL_BEFORE = 'export function total(items: number[]): number {\n  return items.length;\n}\n';
const TOTAL_AFTER = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
const LINE = 'export const line = 1;\n';

async function sampleShop(): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/cart/total.ts': TOTAL_BEFORE, 'src/cart/line.ts': LINE, 'docs/notes.md': '# notes\n' },
  });
  repos.push(repo);
  await repo.branch('feature/checkout');
  return repo;
}

function build(repo: TempRepo, head?: string): ReturnType<typeof buildReportWithHead> {
  return buildReportWithHead({ repoDir: repo.dir, base: 'main', head, now: NOW, runner: ghForbidden().runner, trustConfig: false });
}

describe('fingerprints', () => {
  it('fingerprint/file-before-after: sha256 of the bytes on each side, null where the file is absent', async () => {
    const repo = await sampleShop();
    const added = 'export const token = "";\n';
    await repo.commit('change', { 'src/cart/total.ts': TOTAL_AFTER, 'src/session/token.ts': added, 'docs/notes.md': null });
    const { fingerprints, mergeBase } = await build(repo, await repo.head());
    expect(mergeBase).toBe(await repo.git('rev-parse', 'main'));
    expect(fingerprints.files['src/cart/total.ts']).toEqual({ before: sha(TOTAL_BEFORE), after: sha(TOTAL_AFTER) });
    expect(fingerprints.files['src/session/token.ts']).toEqual({ before: null, after: sha(added) });
    expect(fingerprints.files['docs/notes.md']).toEqual({ before: sha('# notes\n'), after: null });
  });

  it('fingerprint/symbol-slices: sha256 of before slice, NUL, after slice; a one-sided slice is empty', async () => {
    const repo = await sampleShop();
    await repo.commit('change', {
      'src/cart/total.ts': `${TOTAL_AFTER}export function extra(): number {\n  return 1;\n}\n`,
    });
    const { fingerprints } = await build(repo, await repo.head());
    const total = TOTAL_BEFORE.trimEnd();
    const totalAfter = TOTAL_AFTER.trimEnd();
    expect(fingerprints.symbols['src/cart/total.ts#total']).toBe(sha(total, '\0', totalAfter));
    expect(fingerprints.symbols['src/cart/total.ts#extra']).toBe(sha('', '\0', 'export function extra(): number {\n  return 1;\n}'));
  });

  it('fingerprint/symbol-slices: a deleted symbol has an empty after slice', async () => {
    const repo = await sampleShop();
    await repo.commit('drop', { 'src/cart/total.ts': 'export const none = 0;\n' });
    const { fingerprints } = await build(repo, await repo.head());
    expect(fingerprints.symbols['src/cart/total.ts#total']).toBe(sha(TOTAL_BEFORE.trimEnd(), '\0', ''));
  });

  it('fingerprint/rename-old-path: a renamed file carries its old path and both hashes', async () => {
    const repo = await sampleShop();
    await repo.git('mv', 'src/cart/line.ts', 'src/cart/row.ts');
    await repo.commit('rename');
    const { fingerprints } = await build(repo, await repo.head());
    expect(fingerprints.files['src/cart/row.ts']).toEqual({ before: sha(LINE), after: sha(LINE), oldPath: 'src/cart/line.ts' });
    expect(fingerprints.files['src/cart/line.ts']).toBeUndefined();
  });

  it('fingerprint/untouched-equal: an untouched file has before === after and no oldPath', async () => {
    const repo = await sampleShop();
    await repo.commit('change', { 'src/cart/total.ts': TOTAL_AFTER });
    const { fingerprints } = await build(repo, await repo.head());
    expect(fingerprints.files['src/cart/line.ts']).toEqual({ before: sha(LINE), after: sha(LINE) });
    const symbolHashes = Object.entries(fingerprints.symbols).filter(([id]) => id.startsWith('src/cart/line.ts#'));
    expect(symbolHashes).toHaveLength(1);
    expect(symbolHashes[0]?.[1]).toBe(sha('export const line = 1;', '\0', 'export const line = 1;'));
  });

  it('fingerprint/report-unchanged: the Report has no new keys, buildReport agrees, the hash ignores fingerprints', async () => {
    const repo = await sampleShop();
    await repo.commit('change', { 'src/cart/total.ts': TOTAL_AFTER });
    const head = await repo.head();
    const { report } = await build(repo, head);
    const plain = await buildReport({ repoDir: repo.dir, base: 'main', head, now: NOW, runner: ghForbidden().runner, trustConfig: false });
    expect(JSON.stringify(report)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(report)).not.toMatch(/fingerprint|mergeBase/);
    const snapshot = await computeSnapshot({ repoDir: repo.dir, base: 'main', head, now: NOW.toISOString(), trustConfig: false });
    expect(snapshot.contentHash).toBe(contentHashOf(plain));
    expect(JSON.parse(snapshot.reportJson)).toEqual(plain);
  });

  it('fingerprint/report-unchanged: the golden expected.json files are reproduced byte for byte', async () => {
    for (const scenario of listScenarios()) {
      const built = await buildScenario(scenario);
      repos.push(built.repo);
      const { report } = await buildReportWithHead({
        repoDir: built.repo.dir,
        now: new Date(scenario.steps.now),
        runner: ghForbidden().runner,
        trustConfig: true,
      });
      expect(`${JSON.stringify(report, null, 2)}\n`, scenario.name).toBe(readFileSync(scenario.expectedPath, 'utf8'));
    }
  }, 120_000);
});
