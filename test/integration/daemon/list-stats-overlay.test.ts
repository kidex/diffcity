// DC-106: the verdict counts of the change list (`ChangeSummary.stats
// .filesByVerdict`) are the served Report's `summary.byVerdict` (ADR-036), on
// every route that returns a ChangeSummary: the repo's changes, the repo
// detail and the change itself. A change with no imported finding and no rule
// state keeps the stored counts without its Report being read.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import type { ChangeRecord, ChangeSummary, RepoDetail } from '../../../src/core/model/types.js';
import type { Report, Verdict } from '../../../src/core/report/types.js';
import { createServedCache, type ServedCache } from '../../../src/daemon/api/served-cache.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, sampleSummary, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { file, sym, T } from '../../unit/review/review-helpers.js';
import { cleanupAfterEach, startTestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const PRICE = 'src/till/price.ts';
const STOCK = 'src/till/stock.ts';
const LABEL = 'src/till/label.ts';

/** src/till: price, stock and label touched (all ok); src/docs/intro.ts untouched. */
function tillReport(head: string): Report {
  return {
    meta: { repo: 'corner-till', base: 'main', head, commits: 1, generatedAt: T },
    packages: [
      {
        id: 'p-till',
        path: 'src/till',
        tier1: false,
        files: [
          file('f-price', PRICE, 'mod', 'ok', [sym('s-price', 'price')]),
          file('f-stock', STOCK, 'mod', 'ok', [sym('s-stock', 'stock')]),
          file('f-label', LABEL, 'mod', 'ok', [sym('s-label', 'label')]),
        ],
      },
      { id: 'p-docs', path: 'src/docs', tier1: false, files: [file('f-intro', 'src/docs/intro.ts', 'same', 'same', [sym('s-intro', 'intro', 'same')])] },
    ],
    steps: [],
    findings: [],
    summary: {
      files: 4,
      byStatus: { add: 0, mod: 3, sig: 0, del: 0, same: 1 },
      byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 3, same: 1 },
      tier1Files: [],
    },
  };
}

function imported(report: Report, filePath: string, title: string): StoredFinding {
  const input: FindingInput = { source: 'claude', severity: 'high', category: 'correctness', file: filePath, line: 2, title, message: `${title}.` };
  const result = anchor(input, report);
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

interface Seeded {
  db: Db;
  port: number;
  repoId: number;
  till: ChangeRecord;
  /** A change with no findings whose stored Report is a stub with no packages: overlaying it would throw. */
  quiet: ChangeRecord;
  report: Report;
}

async function seeded(servedSummaries?: ServedCache<Record<Verdict, number>>): Promise<Seeded> {
  const test = await startTestDaemon({}, { api: true, ...(servedSummaries === undefined ? {} : { servedSummaries }) });
  const db = test.collection.db();
  const repo = addRepo(db, 'corner-till');
  const [till, quiet] = db.changes.applyPlan(repo.id, { create: [branchFields('till'), branchFields('quiet')], update: [], archive: [] }, T0).created;
  if (till === undefined || quiet === undefined) throw new Error('no changes');
  const report = tillReport(till.head);
  db.snapshots.put(
    snapshotInput(till.id, till.head, { report: JSON.stringify(report), summary: { ...report.summary, touchedFiles: 3 }, contentHash: 'till-1' }),
  );
  db.snapshots.put(snapshotInput(quiet.id, quiet.head, { contentHash: 'quiet-1' }));

  const broadcast = { db, broadcast: (event: Parameters<typeof test.daemon.context.broadcast>[0]) => { test.daemon.context.broadcast(event); } };
  storeFindingsImport(broadcast, repo.id, {
    changeId: till.id,
    head: till.head,
    findings: [imported(report, PRICE, 'Price rounds down'), imported(report, STOCK, 'Stock goes negative')],
    fixed: [],
    at: T0,
  });
  return { db, port: test.daemon.info.port, repoId: repo.id, till, quiet, report };
}

async function get<T>(port: number, path: string): Promise<T> {
  const answer = await call(port, 'GET', path);
  expect(answer.status).toBe(200);
  return answer.json() as T;
}

/** filesByVerdict of `changeId` on each route that returns a ChangeSummary. */
async function listedCounts(s: Seeded, changeId: number): Promise<Record<Verdict, number>[]> {
  const pick = (summaries: ChangeSummary[]): Record<Verdict, number> | undefined => summaries.find((change) => change.id === changeId)?.stats?.filesByVerdict;
  const list = await get<ChangeSummary[]>(s.port, `/api/repos/${String(s.repoId)}/changes`);
  const detail = await get<RepoDetail>(s.port, `/api/repos/${String(s.repoId)}`);
  const one = await get<ChangeSummary>(s.port, `/api/changes/${String(changeId)}`);
  return [pick(list), pick(detail.changes), one.stats?.filesByVerdict].map((counts) => {
    if (counts === undefined) throw new Error(`no counts for change ${String(changeId)}`);
    return counts;
  });
}

const servedByVerdict = async (s: Seeded): Promise<Record<Verdict, number>> =>
  (await get<Report>(s.port, `/api/changes/${String(s.till.id)}/report`)).summary.byVerdict;

describe('list stats overlay (DC-106)', () => {
  it('list-stats/import: after an import that makes two files risky, every listed count equals the served Report', async () => {
    const s = await seeded();
    const served = await servedByVerdict(s);
    expect(served).toEqual({ eyes: 0, risky: 2, spec: 0, ok: 1, same: 1 });
    for (const counts of await listedCounts(s, s.till.id)) expect(counts).toEqual(served);
  });

  it('list-stats/intended: "Mark as intended" brings the listed risky count back down with the served Report', async () => {
    const s = await seeded();
    const key = s.db.findings.list(s.till.id).find((entry) => entry.finding.file === PRICE)?.key;
    if (key === undefined) throw new Error('no finding on price.ts');
    // The list read before the write, so a stale cached count would show.
    for (const counts of await listedCounts(s, s.till.id)) expect(counts.risky).toBe(2);

    const answer = await call(s.port, 'PUT', `/api/changes/${String(s.till.id)}/findings/${key}/state`, { body: { state: 'intended' } });
    expect(answer.status).toBe(200);
    const served = await servedByVerdict(s);
    expect(served).toEqual({ eyes: 0, risky: 1, spec: 0, ok: 2, same: 1 });
    for (const counts of await listedCounts(s, s.till.id)) expect(counts).toEqual(served);
  });

  it('list-stats/no-findings: a change with no findings keeps the stored counts and its Report is never read', async () => {
    const summaries = createServedCache<Record<Verdict, number>>();
    const s = await seeded(summaries);
    for (const counts of await listedCounts(s, s.quiet.id)) expect(counts).toEqual(sampleSummary().byVerdict);
    // Only the change with findings went through the overlay summaries: the list
    // missed, the repo detail hit, and /api/changes/:id of the quiet change never looked.
    expect(summaries.stats).toEqual({ hits: 1, misses: 1 });
  });

  it('list-stats/cached: list calls overlay a change once per (snapshot, findings version)', async () => {
    const summaries = createServedCache<Record<Verdict, number>>();
    const s = await seeded(summaries);
    await get<ChangeSummary[]>(s.port, `/api/repos/${String(s.repoId)}/changes`);
    await get<ChangeSummary[]>(s.port, `/api/repos/${String(s.repoId)}/changes`);
    expect(summaries.stats).toEqual({ hits: 1, misses: 1 });
    // A findings write misses again.
    s.db.findings.setRuleState(s.till.id, 'rule:size:none', s.till.head, 'intended', T0);
    await get<ChangeSummary[]>(s.port, `/api/repos/${String(s.repoId)}/changes`);
    expect(summaries.stats).toEqual({ hits: 1, misses: 2 });
  });
});
