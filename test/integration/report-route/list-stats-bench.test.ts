// report-route/list-stats-bench (DC-106): GET /api/repos/:id/changes for a
// repo of 50 changes, each a 2,000-file Report (the `large` preset of
// gen-large-city.mjs) with 20 imported findings, so every listed count is the
// served Report's. Warm (the overlay summaries cached) it stays under 100 ms,
// as the median of 9 requests; the stored path (no findings) and the cold list
// (50 overlays, as after a daemon restart) are measured and printed for the
// record. Runs in the `timing` project, one file at a time.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchor, type StoredFinding } from '../../../src/core/findings/index.js';
import type { ChangeSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, startTestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const CHANGES = 50;
const FINDINGS_PER_CHANGE = 20;
const WARM_RUNS = 9;
const WARM_BUDGET_MS = 100;

let dir: string;
let json: string;
let report: Report;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-list-bench-'));
  const out = join(dir, 'large.json');
  execFileSync(process.execPath, ['test/fixtures/ui/gen-large-city.mjs', '--preset', 'large', '--out', out]);
  json = readFileSync(out, 'utf8');
  report = JSON.parse(json) as Report;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
};

/** FINDINGS_PER_CHANGE high findings on the `ok` files, starting at `offset`, as an import would anchor them. */
function findingsFrom(offset: number): StoredFinding[] {
  const touched = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.verdict === 'ok');
  const stored: StoredFinding[] = [];
  for (let i = 0; stored.length < FINDINGS_PER_CHANGE && i < touched.length; i += 1) {
    const file = touched[(offset + i) % touched.length];
    if (file === undefined) break;
    const result = anchor(
      {
        source: 'claude',
        severity: 'high',
        category: 'correctness',
        file: file.path,
        line: file.symbols[0]?.range.start ?? 1,
        title: `Synthetic finding ${String(offset + i)}`,
        message: 'An invented finding for the list bench.',
      },
      report,
    );
    if (result.ok) stored.push(result.stored);
  }
  return stored;
}

describe('report-route/list-stats-bench', () => {
  it(`lists ${String(CHANGES)} changes with findings in under ${String(WARM_BUDGET_MS)} ms warm`, async () => {
    const test = await startTestDaemon({}, { api: true });
    const db = test.collection.db();
    const repo = addRepo(db);
    const plan = { create: Array.from({ length: CHANGES }, (_, i) => branchFields(`lane-${String(i)}`)), update: [], archive: [] };
    const changes = db.changes.applyPlan(repo.id, plan, T0).created;
    expect(changes).toHaveLength(CHANGES);
    const summary = { ...report.summary, touchedFiles: report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same').length };
    for (const [i, change] of changes.entries()) {
      db.snapshots.put(snapshotInput(change.id, change.head, { report: json, summary, contentHash: `large-${String(i)}` }));
    }
    const port = test.daemon.info.port;
    const url = `/api/repos/${String(repo.id)}/changes`;
    const list = async (): Promise<{ ms: number; changes: ChangeSummary[] }> => {
      const start = performance.now();
      const answer = await call(port, 'GET', url);
      const ms = performance.now() - start;
      expect(answer.status).toBe(200);
      return { ms, changes: answer.json() as ChangeSummary[] };
    };

    // The stored path: no findings, the counts straight from the snapshot rows.
    await list();
    const storedRuns: number[] = [];
    for (let i = 0; i < 5; i += 1) storedRuns.push((await list()).ms);

    for (const [i, change] of changes.entries()) {
      db.findings.importBatch({ changeId: change.id, head: change.head, findings: findingsFrom(i * 7), fixed: [], at: T0 });
    }

    const cold = await list();
    const warmRuns: number[] = [];
    for (let i = 0; i < WARM_RUNS; i += 1) warmRuns.push((await list()).ms);
    // The imported findings show in every listed count.
    for (const change of cold.changes) expect(change.stats?.filesByVerdict.risky).toBeGreaterThan(report.summary.byVerdict.risky);

    const line = (label: string, ms: number): string => `${label.padEnd(36)}${ms.toFixed(1)} ms`;
    console.log(
      [
        `list bench: ${String(CHANGES)} changes, ${(json.length / 1e6).toFixed(1)} MB Report each, ${String(FINDINGS_PER_CHANGE)} imported findings each`,
        line('stored counts, median of 5', median(storedRuns)),
        line(`cold list (${String(CHANGES)} overlays)`, cold.ms),
        line(`warm list, median of ${String(WARM_RUNS)}`, median(warmRuns)),
        line('warm list, max', Math.max(...warmRuns)),
      ].join('\n'),
    );
    expect(median(warmRuns)).toBeLessThan(WARM_BUDGET_MS);
  });
});
