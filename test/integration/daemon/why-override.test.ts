// DC-106 (SPEC.md 5.4 point 5, DC-97): an imported finding with a `why` hint
// that is not fixed replaces the `why` of its symbol's step in the served
// Report; the stored Report is not changed. "Mark as intended" keeps the hint;
// once the finding is fixed the rule text is back.

import { describe, expect, it } from 'vitest';
import { anchor } from '../../../src/core/findings/index.js';
import type { Report } from '../../../src/core/report/types.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { file, sym, T } from '../../unit/review/review-helpers.js';
import { cleanupAfterEach, startTestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const ROUTE = 'src/kiosk/route.ts';
const QUEUE = 'src/kiosk/queue.ts';

/** src/kiosk: a new route that calls a changed queue function, as a reading path. */
function kioskReport(head: string): Report {
  return {
    meta: { repo: 'ticket-kiosk', base: 'main', head, commits: 1, generatedAt: T },
    packages: [
      {
        id: 'p-kiosk',
        path: 'src/kiosk',
        tier1: false,
        files: [file('f-route', ROUTE, 'add', 'ok', [sym('s-route', 'issueTicket', 'add')]), file('f-queue', QUEUE, 'mod', 'ok', [sym('s-queue', 'nextNumber')])],
      },
    ],
    steps: [
      { order: 1, symbolId: 's-route', fileId: 'f-route', why: 'New function', diff: [], section: 'path', entry: 's-route' },
      { order: 2, symbolId: 's-queue', fileId: 'f-queue', why: 'Body changed', diff: [], section: 'path', entry: 's-route' },
    ],
    findings: [],
    summary: { files: 2, byStatus: { add: 1, mod: 1, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 2, same: 0 }, tier1Files: [] },
  };
}

describe('why override (DC-106)', () => {
  it("report-route/why-override: the served Report shows the hint on its symbol's step; the stored Report is unchanged", async () => {
    const test = await startTestDaemon({}, { api: true });
    const db = test.collection.db();
    const repo = addRepo(db, 'ticket-kiosk');
    const change = db.changes.applyPlan(repo.id, { create: [branchFields('tickets')], update: [], archive: [] }, T0).created[0];
    if (change === undefined) throw new Error('no change');
    const report = kioskReport(change.head);
    const stored = JSON.stringify(report);
    db.snapshots.put(snapshotInput(change.id, change.head, { report: stored, summary: { ...report.summary, touchedFiles: 2 }, contentHash: 'kiosk-1' }));

    const hinted = anchor(
      { source: 'claude', severity: 'med', category: 'correctness', file: QUEUE, line: 2, title: 'Numbers can repeat', message: 'Two kiosks can read the same number.', why: 'called by the new route without a lock' },
      report,
    );
    if (!hinted.ok) throw new Error('not anchored');
    storeFindingsImport({ db, broadcast: () => undefined }, repo.id, { changeId: change.id, head: change.head, findings: [hinted.stored], fixed: [], at: T0 });

    const port = test.daemon.info.port;
    const served = async (): Promise<string[]> => {
      const answer = await call(port, 'GET', `/api/changes/${String(change.id)}/report`);
      expect(answer.status).toBe(200);
      return (answer.json() as Report).steps.map((step) => step.why);
    };
    expect(await served()).toEqual(['New function', 'called by the new route without a lock']);
    expect(db.snapshots.latestReport(change.id)).toBe(stored);

    const key = hinted.stored.key;
    expect((await call(port, 'PUT', `/api/changes/${String(change.id)}/findings/${key}/state`, { body: { state: 'intended' } })).status).toBe(200);
    expect(await served()).toEqual(['New function', 'called by the new route without a lock']);

    // An import that no longer reports the finding fixes it (an intended row is
    // kept as intended, so it is reopened first): the rule text is back.
    expect((await call(port, 'PUT', `/api/changes/${String(change.id)}/findings/${key}/state`, { body: { state: 'open' } })).status).toBe(200);
    storeFindingsImport({ db, broadcast: () => undefined }, repo.id, { changeId: change.id, head: change.head, findings: [], fixed: [key], at: T0 });
    expect(db.findings.get(change.id, key)?.finding.state).toBe('fixed');
    expect(await served()).toEqual(['New function', 'Body changed']);
    expect(db.snapshots.latestReport(change.id)).toBe(stored);
  });
});
