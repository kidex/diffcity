// Rules in the daemon's collection (ADR-030): the snapshot carries the rule
// findings and checks, a change of the repo config (its mtime) or of the
// settings rules computes the snapshot again on the same head, and "Mark as
// intended" on a rule finding sticks across snapshots (the rule-state rows
// of ADR-036). Temp DIFFCITY_HOME, invented `shopfront` repo.

import { realpath, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const BRANCH = 'agent/cart';
const TOTAL = 'src/cart/total.ts';

function body(count: number): string {
  return ['export function total(items: number[]): number {', ...Array.from({ length: count }, (_, i) => `  items.push(${String(i)});`), '  return items.length;', '}', ''].join('\n');
}

function configWith(maxLines: number): string {
  return `export default { rules: [{ id: 'repo-size', kind: 'file-size', maxLines: ${String(maxLines)} }] };\n`;
}

async function writeSettings(test: TestDaemon, settings: Record<string, unknown>): Promise<void> {
  await writeFile(join(test.home.home, 'settings.json'), JSON.stringify({ v: 1, ...settings }));
}

async function collect(test: TestDaemon, dir: string): Promise<number> {
  const response = await test.track(dir);
  if (!response.ok) throw new Error(response.error);
  await test.idle();
  return response.repo.id;
}

function branchChange(test: TestDaemon, repoId: number): ChangeRecord {
  const change = test.collection.db().changes.listLive(repoId).find((candidate) => candidate.ref.endsWith(BRANCH));
  if (change === undefined) throw new Error('the branch change was not collected');
  return change;
}

function storedReport(test: TestDaemon, changeId: number): Report {
  const json = test.collection.db().snapshots.latestReport(changeId);
  if (json === null) throw new Error('no snapshot');
  return JSON.parse(json) as Report;
}

const checkStates = (report: Report): string[] => (report.checks ?? []).map((check) => `${check.ruleId}:${check.state}:${String(check.findings)}`);

describe('rules in the collection', () => {
  it('rules/config-mtime-recompute: an edited repo config or settings rules recompute the snapshot of an unchanged head', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const repo = await sampleRepo({ name: 'shopfront', files: { 'diffcity.config.js': configWith(100), [TOTAL]: body(1), 'README.md': '# shopfront\n' } });
    await repo.branch(BRANCH);
    await repo.commit('longer total', { [TOTAL]: body(10) });
    const root = await realpath(repo.dir);
    await writeSettings(test, { trustedRepos: [root] });

    const repoId = await collect(test, repo.dir);
    const change = branchChange(test, repoId);
    expect(checkStates(storedReport(test, change.id))).toEqual(['repo-size:passed:0']);

    // The repo config changes (the daemon only sees its mtime and imports it again).
    await writeFile(join(repo.dir, 'diffcity.config.js'), configWith(5));
    const later = new Date(Date.now() + 5_000);
    await utimes(join(repo.dir, 'diffcity.config.js'), later, later);
    await repo.git('update-index', '--assume-unchanged', 'diffcity.config.js');
    await collect(test, repo.dir);
    expect(branchChange(test, repoId).head).toBe(change.head);
    expect(checkStates(storedReport(test, change.id))).toEqual(['repo-size:violations:1']);

    // The settings rules change: computed again, the user's rule joins.
    await writeSettings(test, { trustedRepos: [root], repos: { [root]: { rules: [{ id: 'fn-size', kind: 'file-size', maxSymbolLines: 3 }] } } });
    await collect(test, repo.dir);
    expect(checkStates(storedReport(test, change.id))).toEqual(['fn-size:violations:1', 'repo-size:violations:1']);

    // Untrusted again: the repo config rules leave, the user's stay.
    await writeSettings(test, { trustedRepos: [], repos: { [root]: { rules: [{ id: 'fn-size', kind: 'file-size', maxSymbolLines: 3 }] } } });
    await collect(test, repo.dir);
    expect(checkStates(storedReport(test, change.id))).toEqual(['fn-size:violations:1']);
  });

  it('rules/rule-finding-intended-sticks: a rule finding marked intended stays intended, and its file ok, on the next head', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const repo = await sampleRepo({ name: 'shopfront', files: { [TOTAL]: body(1), 'README.md': '# shopfront\n' } });
    await repo.branch(BRANCH);
    await repo.commit('longer total', { [TOTAL]: body(10) });
    await writeSettings(test, { trustedRepos: [], rules: [{ id: 'size', kind: 'file-size', severity: 'high', maxLines: 5 }] });

    const repoId = await collect(test, repo.dir);
    const change = branchChange(test, repoId);
    const [finding] = storedReport(test, change.id).findings;
    expect(finding).toMatchObject({ source: 'rule:size', file: TOTAL, line: 0, title: 'File over 5 lines', state: 'open' });
    if (finding === undefined) throw new Error('unreachable');
    const port = test.daemon.info.port;
    const served = async (): Promise<Report> => (await call(port, 'GET', `/api/changes/${String(change.id)}/report`)).json() as Report;
    expect((await served()).packages.flatMap((pkg) => pkg.files).find((file) => file.path === TOTAL)?.verdict).toBe('risky');

    const answer = await call(port, 'PUT', `/api/changes/${String(change.id)}/findings/${encodeURIComponent(finding.id)}/state`, { body: { state: 'intended' } });
    expect(answer.status).toBe(200);

    // A new head: the rule finding is computed again, with the same id.
    await repo.commit('even longer total', { [TOTAL]: body(14) });
    await collect(test, repo.dir);
    const next = branchChange(test, repoId);
    expect(next.head).not.toBe(change.head);
    expect(storedReport(test, change.id).findings.map((entry) => [entry.id, entry.state])).toEqual([[finding.id, 'open']]);
    const report = await served();
    expect(report.meta.head).toBe(next.head);
    expect(report.findings.map((entry) => [entry.id, entry.state])).toEqual([[finding.id, 'intended']]);
    expect(report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === TOTAL)?.verdict).toBe('ok');
  });
});
