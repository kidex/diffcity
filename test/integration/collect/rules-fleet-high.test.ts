// Rule findings in the Fleet count (ADR-030, DC-106): an open high rule
// finding is part of the stored Report, so the repo summary's highFindings
// counts it like any other open high finding, before anyone touches a
// finding state. Temp DIFFCITY_HOME, invented `ledger` repo.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const JOURNAL = 'src/ledger/journal.ts';

function body(count: number): string {
  return ['export function post(entries: number[]): number {', ...Array.from({ length: count }, (_, i) => `  entries.push(${String(i)});`), '  return entries.length;', '}', ''].join('\n');
}

describe('rules in the Fleet summary', () => {
  it('rules/high-counted-in-fleet: an open high rule finding counts in the repo highFindings', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const repo = await sampleRepo({ name: 'ledger', files: { [JOURNAL]: body(1), 'README.md': '# ledger\n' } });
    await repo.branch('agent/journal');
    await repo.commit('grow journal', { [JOURNAL]: body(10) });
    await writeFile(join(test.home.home, 'settings.json'), JSON.stringify({ v: 1, trustedRepos: [], rules: [{ id: 'big-files', kind: 'file-size', severity: 'high', maxLines: 5 }] }));

    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const repoId = tracked.repo.id;
    const change = test.collection.db().changes.listLive(repoId).find((candidate) => candidate.ref.endsWith('agent/journal'));
    if (change === undefined) throw new Error('the branch change was not collected');

    const port = test.daemon.info.port;
    const report = (await (await call(port, 'GET', `/api/changes/${String(change.id)}/report`)).json()) as Report;
    expect(report.findings.filter((finding) => finding.state === 'open' && finding.severity === 'high')).toHaveLength(1);

    const repos = (await (await call(port, 'GET', '/api/repos')).json()) as { id: number; highFindings: number }[];
    expect(repos.find((entry) => entry.id === repoId)?.highFindings).toBe(1);
  });
});
