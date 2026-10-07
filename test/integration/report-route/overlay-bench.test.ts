// report-route/overlay-bench (ADR-036): the served Report of the 8,000-file
// synthetic city (the `huge` preset of gen-large-city.mjs, about 13 MB) with
// 600 imported findings and a rule state is served in under 200 ms warm (from
// the cache), measured over HTTP as the median of 9 requests. The cold overlay
// (parse, overlay, serialise) and the stored path are measured and printed for
// the record. Runs in the `timing` project, one file at a time.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchor, type StoredFinding } from '../../../src/core/findings/index.js';
import type { Report } from '../../../src/core/report/types.js';
import { serveReport } from '../../../src/core/served/index.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, startTestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const IMPORTED = 600;
const WARM_RUNS = 9;
const WARM_BUDGET_MS = 200;

let dir: string;
let json: string;
let report: Report;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-overlay-bench-'));
  const out = join(dir, 'huge.json');
  execFileSync(process.execPath, ['test/fixtures/ui/gen-large-city.mjs', '--preset', 'huge', '--out', out]);
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

/** IMPORTED findings over the touched files, the generator's own findings first, as an import would anchor them. */
function importedFindings(): StoredFinding[] {
  const touched = report.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same');
  const inputs = report.findings;
  const stored: StoredFinding[] = [];
  for (const finding of inputs) {
    const result = anchor({ source: finding.source, severity: finding.severity, category: finding.category, file: finding.file, line: finding.line, title: finding.title, message: finding.message }, report);
    if (result.ok) stored.push(result.stored);
  }
  for (let i = 0; stored.length < IMPORTED; i += 1) {
    const file = touched[i % touched.length];
    if (file === undefined) break;
    const symbol = file.symbols[i % Math.max(1, file.symbols.length)];
    const result = anchor(
      {
        source: i % 3 === 0 ? 'semgrep' : 'claude',
        severity: (['high', 'med', 'low'] as const)[i % 3] ?? 'low',
        category: 'correctness',
        file: file.path,
        line: symbol?.range.start ?? 1,
        title: `Synthetic finding ${String(i)}`,
        message: 'An invented finding for the overlay bench.',
      },
      report,
    );
    if (result.ok) stored.push(result.stored);
  }
  return stored;
}

describe('report-route/overlay-bench', () => {
  it(`serves the overlay of the 8,000-file Report in under ${String(WARM_BUDGET_MS)} ms warm`, async () => {
    expect(report.packages.reduce((n, pkg) => n + pkg.files.length, 0)).toBe(8000);
    const test = await startTestDaemon({}, { api: true });
    const db = test.collection.db();
    const repo = addRepo(db);
    const change = db.changes.applyPlan(repo.id, { create: [branchFields('huge')], update: [], archive: [] }, T0).created[0];
    if (change === undefined) throw new Error('no change');
    db.snapshots.put(snapshotInput(change.id, change.head, { report: json, contentHash: 'huge-1' }));
    const port = test.daemon.info.port;
    const url = `/api/changes/${String(change.id)}/report`;
    const get = async (): Promise<{ ms: number; bytes: number }> => {
      const start = performance.now();
      const answer = await call(port, 'GET', url);
      const ms = performance.now() - start;
      expect(answer.status).toBe(200);
      return { ms, bytes: answer.text.length };
    };

    // The stored path: no findings, the stored string as it is.
    await get();
    const storedRuns: number[] = [];
    for (let i = 0; i < 5; i += 1) storedRuns.push((await get()).ms);

    const findings = importedFindings();
    expect(findings).toHaveLength(IMPORTED);
    db.findings.importBatch({ changeId: change.id, head: change.head, findings, fixed: [], at: T0 });
    db.findings.setRuleState(change.id, 'rule:size:bench', change.head, 'intended', T0);

    // Cold: the in-process overlay alone, then the first request after the write (overlay + send).
    const stored = db.findings.list(change.id);
    const ruleStates = db.findings.ruleStates(change.id);
    const overlayRuns: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      serveReport(json, { stored, ruleStates });
      overlayRuns.push(performance.now() - start);
    }
    const cold = await get();

    const warmRuns: number[] = [];
    for (let i = 0; i < WARM_RUNS; i += 1) warmRuns.push((await get()).ms);
    const served = JSON.parse((await call(port, 'GET', url)).text) as Report;
    expect(served.findings.length).toBeGreaterThan(0);

    const line = (label: string, ms: number): string => `${label.padEnd(34)}${ms.toFixed(1)} ms`;
    console.log(
      [
        `overlay bench: 8,000 files, ${(json.length / 1e6).toFixed(1)} MB stored, ${String(IMPORTED)} imported findings + 1 rule state, served ${(cold.bytes / 1e6).toFixed(1)} MB`,
        line('stored string, median of 5', median(storedRuns)),
        line('overlay in process, median of 3', median(overlayRuns)),
        line('cold request (overlay + send)', cold.ms),
        line(`warm request, median of ${String(WARM_RUNS)}`, median(warmRuns)),
        line('warm request, max', Math.max(...warmRuns)),
      ].join('\n'),
    );
    expect(median(warmRuns)).toBeLessThan(WARM_BUDGET_MS);
  });
});
