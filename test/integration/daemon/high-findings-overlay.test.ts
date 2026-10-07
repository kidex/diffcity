// DC-106: RepoSummary.highFindings (Fleet's "high findings") is the number of
// open high findings in the served Reports (ADR-036) of the repo's live
// changes, not a count of raw findings rows: a finding re-anchored on a newer
// snapshot counts, duplicates the overlay merges count once, a finding whose
// file left the change does not count, and a high rule finding does.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import type { ChangeRecord, RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { servedCountsCache } from '../../../src/daemon/api/served-cache.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, daysAfter, sha, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { file, sym, T } from '../../unit/review/review-helpers.js';
import { cleanupAfterEach, startTestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const PRICE = 'src/till/price.ts';
const STOCK = 'src/till/stock.ts';
const LABEL = 'src/till/label.ts';

const RULE: Finding = {
  id: 'rule:size:0b0b',
  source: 'rule:size',
  severity: 'high',
  category: 'architecture',
  file: PRICE,
  line: 2,
  title: 'File over the size limit',
  message: 'price.ts is over the limit.',
  state: 'open',
};

interface TillOptions {
  /** Moves the `price` symbol down by this many lines. */
  shift?: number;
  /** Leaves this file out of the change. */
  without?: string;
  /** Adds the high rule finding on price.ts. */
  rule?: boolean;
}

/** src/till: price, stock and label touched (all ok), as an invented snapshot of `head`. */
function tillReport(head: string, options: TillOptions = {}): Report {
  const shift = options.shift ?? 0;
  const files = [
    file('f-price', PRICE, 'mod', options.rule === true ? 'risky' : 'ok', [{ ...sym('s-price', 'price'), range: { start: 1 + shift, end: 5 + shift } }]),
    file('f-stock', STOCK, 'mod', 'ok', [sym('s-stock', 'stock')]),
    file('f-label', LABEL, 'mod', 'ok', [sym('s-label', 'label')]),
  ].filter((entry) => entry.path !== options.without);
  return {
    meta: { repo: 'corner-till', base: 'main', head, commits: 1, generatedAt: T },
    packages: [{ id: 'p-till', path: 'src/till', tier1: false, files }],
    steps: [],
    findings: options.rule === true ? [RULE] : [],
    summary: {
      files: files.length,
      byStatus: { add: 0, mod: files.length, sig: 0, del: 0, same: 0 },
      byVerdict: { eyes: 0, risky: options.rule === true ? 1 : 0, spec: 0, ok: files.length - (options.rule === true ? 1 : 0), same: 0 },
      tier1Files: [],
    },
  };
}

function finding(report: Report, overrides: Partial<FindingInput>): StoredFinding {
  const input: FindingInput = { source: 'claude', severity: 'high', category: 'correctness', file: PRICE, line: 2, title: 'Price rounds down', message: 'Rounds down.', ...overrides };
  const result = anchor(input, report);
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

function put(db: Db, change: ChangeRecord, head: string, report: Report, at: string): void {
  db.snapshots.put(snapshotInput(change.id, head, { report: JSON.stringify(report), summary: { ...report.summary, touchedFiles: report.summary.files }, contentHash: `${head}-${at}`, computedAt: at }));
}

function store(db: Db, change: ChangeRecord, head: string, findings: StoredFinding[]): void {
  db.findings.importBatch({ changeId: change.id, head, findings, fixed: [], at: T0 });
}

async function get<T>(port: number, path: string): Promise<T> {
  const answer = await call(port, 'GET', path);
  expect(answer.status).toBe(200);
  return answer.json() as T;
}

const openHigh = (report: Report): number => report.findings.filter((entry) => entry.state === 'open' && entry.severity === 'high').length;

describe('highFindings from the served overlay (DC-106)', () => {
  it('fleet/high-findings: each case counts as its served Report does, and Fleet shows their sum', async () => {
    const counts = servedCountsCache();
    const test = await startTestDaemon({}, { api: true, servedSummaries: counts });
    const db = test.collection.db();
    // One repo per case, so each repo's number is checked on its own; the raw
    // rows would count 0, 3, 1, 0 and 0 where the served Reports count 1, 1, 0, 1 and 0.
    const cases = ['moved', 'merged', 'left', 'rule', 'quiet'].map((name) => {
      const repo = addRepo(db, `till-${name}`);
      const change = db.changes.applyPlan(repo.id, { create: [branchFields(name)], update: [], archive: [] }, T0).created[0];
      if (change === undefined) throw new Error('no change');
      return { repo, change };
    });
    const [moved, merged, left, rule, quiet] = cases;
    if (moved === undefined || merged === undefined || left === undefined || rule === undefined || quiet === undefined) throw new Error('no cases');

    // Re-anchored: imported on an older head, the symbol moved in the newer snapshot.
    const oldHead = sha();
    put(db, moved.change, oldHead, tillReport(oldHead), T0);
    store(db, moved.change, oldHead, [finding(tillReport(oldHead), {})]);
    put(db, moved.change, moved.change.head, tillReport(moved.change.head, { shift: 10 }), daysAfter(T0, 1));
    // An archived change of the same repo never counts.
    const gone = db.changes.applyPlan(moved.repo.id, { create: [branchFields('gone')], update: [], archive: [] }, T0).created[0];
    if (gone === undefined) throw new Error('no change');
    put(db, gone, gone.head, tillReport(gone.head), T0);
    store(db, gone, gone.head, [finding(tillReport(gone.head), {})]);
    db.changes.applyPlan(moved.repo.id, { create: [], update: [], archive: [{ id: gone.id, reason: 'merged' }] }, T0);

    // Merged: the same finding from three sources is one served finding.
    const m = merged.change;
    put(db, m, m.head, tillReport(m.head), T0);
    store(db, m, m.head, ['claude', 'semgrep', 'codeql'].map((source) => finding(tillReport(m.head), { file: STOCK, source })));

    // Left the change: label.ts is gone from a later collection of the same head.
    const l = left.change;
    put(db, l, l.head, tillReport(l.head), T0);
    store(db, l, l.head, [finding(tillReport(l.head), { file: LABEL })]);
    put(db, l, l.head, tillReport(l.head, { without: LABEL }), daysAfter(T0, 1));

    // A high rule finding counts; the change is in the overlay through a med import.
    const r = rule.change;
    put(db, r, r.head, tillReport(r.head, { rule: true }), T0);
    store(db, r, r.head, [finding(tillReport(r.head), { file: LABEL, severity: 'med' })]);

    // No findings: the cheap path, nothing to add.
    put(db, quiet.change, quiet.change.head, tillReport(quiet.change.head), T0);

    const port = test.daemon.info.port;
    const served = async (change: ChangeRecord): Promise<number> => openHigh(await get<Report>(port, `/api/changes/${String(change.id)}/report`));
    const perCase = [];
    for (const entry of cases) perCase.push(await served(entry.change));
    expect(perCase).toEqual([1, 1, 0, 1, 0]);

    const fleet = await get<RepoSummary[]>(port, '/api/repos');
    const fleetOf = (entries: RepoSummary[], id: number): number | undefined => entries.find((entry) => entry.id === id)?.highFindings;
    expect(cases.map((entry) => fleetOf(fleet, entry.repo.id))).toEqual(perCase);
    expect(fleet.reduce((total, entry) => total + entry.highFindings, 0)).toBe(perCase.reduce((a, b) => a + b, 0));
    for (const entry of cases) expect((await get<RepoDetail>(port, `/api/repos/${String(entry.repo.id)}`)).repo.highFindings).toBe(fleetOf(fleet, entry.repo.id));

    // "Mark as intended" on the rule finding takes it out of the count.
    expect((await call(port, 'PUT', `/api/changes/${String(r.id)}/findings/${RULE.id}/state`, { body: { state: 'intended' } })).status).toBe(200);
    expect(await served(r)).toBe(0);
    expect(fleetOf(await get<RepoSummary[]>(port, '/api/repos'), rule.repo.id)).toBe(0);
  });

  it('fleet/high-findings-cached: the counts come from the summary cache, one overlay per (snapshot, findings version)', async () => {
    const counts = servedCountsCache();
    const test = await startTestDaemon({}, { api: true, servedSummaries: counts });
    const db = test.collection.db();
    const repo = addRepo(db, 'corner-till');
    const change = db.changes.applyPlan(repo.id, { create: [branchFields('till')], update: [], archive: [] }, T0).created[0];
    if (change === undefined) throw new Error('no change');
    put(db, change, change.head, tillReport(change.head), T0);
    store(db, change, change.head, [finding(tillReport(change.head), {})]);
    const port = test.daemon.info.port;

    // The repo list, the repo detail (repo and changes) and the change list share one overlay.
    await get<RepoSummary[]>(port, '/api/repos');
    await get<RepoDetail>(port, `/api/repos/${String(repo.id)}`);
    expect(counts.stats).toEqual({ hits: 2, misses: 1 });
    expect((await get<RepoSummary[]>(port, '/api/repos'))[0]?.highFindings).toBe(1);
  });
});
