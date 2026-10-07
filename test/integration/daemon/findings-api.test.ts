// The findings actions, Approve and the served Report (ADR-036) over HTTP
// against an in-process daemon with the API plugin, a temporary DIFFCITY_HOME
// and a database seeded with an invented change (no repository needed).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import type { ApiError, ChangeRecord } from '../../../src/core/model/types.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
import { waitFor } from '../../helpers/daemon.js';
import { call } from '../../helpers/review-api.js';
import { addRepo, branchFields, sha, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { sampleFingerprints, sampleReport } from '../../unit/review/review-helpers.js';
import { cleanupAfterEach, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

cleanupAfterEach();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOTAL = 'src/cart/total.ts';
const TAX = 'src/cart/tax.ts';

/** A rule finding on tax.ts, as the report builder would compute it. */
const RULE: Finding = {
  id: 'rule:size:00aa',
  source: 'rule:size',
  severity: 'high',
  category: 'architecture',
  file: TAX,
  line: 2,
  symbolId: 's-rate',
  title: 'File over the size limit',
  message: 'tax.ts is over the limit.',
  state: 'open',
};

/** The review sample with total.ts as tier 1 and, when asked, the rule finding (tax.ts then risky). */
function report(options: { rule?: boolean; head?: string } = {}): Report {
  const base = sampleReport();
  const packages = base.packages.map((pkg) => ({
    ...pkg,
    files: pkg.files.map((file) => (file.path === TAX && options.rule === true ? { ...file, verdict: 'risky' as const } : file)),
  }));
  return {
    ...base,
    meta: { ...base.meta, head: options.head ?? base.meta.head },
    packages,
    findings: options.rule === true ? [RULE] : [],
    summary: {
      ...base.summary,
      byVerdict: options.rule === true ? { eyes: 1, risky: 1, spec: 0, ok: 0, same: 1 } : base.summary.byVerdict,
      tier1Files: [TOTAL],
    },
  };
}

interface Seeded {
  test: TestDaemon;
  db: Db;
  port: number;
  repoId: number;
  change: ChangeRecord;
  /** The stored Report string, with odd spacing so a re-serialisation would show. */
  stored: string;
}

async function seeded(options: { rule?: boolean; archived?: boolean; worktree?: boolean; kind?: 'branch' | 'pr' } = {}): Promise<Seeded> {
  const test = await startTestDaemon({}, { api: true });
  const db = test.collection.db();
  const repo = addRepo(db);
  let worktreePath: string | null = null;
  if (options.worktree === true) {
    worktreePath = mkdtempSync(join(tmpdir(), 'dc-tree-'));
    dirs.push(worktreePath);
  }
  const fields =
    options.kind === 'pr'
      ? branchFields('totals', { kind: 'pr', ref: 'pr:4', prNumber: 4, worktreePath })
      : branchFields('totals', { worktreePath });
  const change = db.changes.applyPlan(repo.id, { create: [fields], update: [], archive: [] }, T0).created[0];
  if (change === undefined) throw new Error('no change');
  const stored = JSON.stringify(report({ rule: options.rule ?? false, head: change.head }), null, 1);
  db.snapshots.put(snapshotInput(change.id, change.head, { report: stored, fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h1' }));
  if (options.archived === true) {
    db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, '2026-09-02T00:00:00.000Z');
  }
  return { test, db, port: test.daemon.info.port, repoId: repo.id, change, stored };
}

function imported(overrides: Partial<FindingInput> = {}): StoredFinding {
  const result = anchor(
    {
      source: 'claude',
      severity: 'high',
      category: 'correctness',
      file: TAX,
      line: 3,
      title: 'Rate read before it is set',
      message: 'taxRate reads the rate before the config loads.',
      fix: 'Load the config first.',
      ...overrides,
    },
    sampleReport(),
    sampleFingerprints(),
  );
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

function importInto(s: Seeded, findings: StoredFinding[]): void {
  storeFindingsImport({ db: s.db, broadcast: (event) => { s.test.daemon.context.broadcast(event); } }, s.repoId, {
    changeId: s.change.id,
    head: s.change.head,
    findings,
    fixed: [],
    at: T0,
  });
}

const path = (s: Seeded, rest: string): string => `/api/changes/${String(s.change.id)}${rest}`;
const errorCode = (answer: { json(): unknown }): string => (answer.json() as ApiError).error.code;
const verdictOf = (r: Report, file: string): string | undefined => r.packages.flatMap((p) => p.files).find((f) => f.path === file)?.verdict;

async function served(s: Seeded): Promise<{ text: string; report: Report }> {
  const answer = await call(s.port, 'GET', path(s, '/report'));
  expect(answer.status).toBe(200);
  return { text: answer.text, report: JSON.parse(answer.text) as Report };
}

describe('report-route', () => {
  it('report-route/stored-report-unchanged: without findings or rule states the stored string is sent byte for byte, and writes never touch it', async () => {
    const s = await seeded({ rule: true });
    expect((await served(s)).text).toBe(s.stored);

    importInto(s, [imported()]);
    const overlaid = await served(s);
    expect(overlaid.text).not.toBe(s.stored);
    expect(s.db.snapshots.latestReport(s.change.id)).toBe(s.stored);

    const answer = await call(s.port, 'PUT', path(s, `/findings/${RULE.id}/state`), { body: { state: 'intended' } });
    expect(answer.status).toBe(200);
    expect(s.db.snapshots.latestReport(s.change.id)).toBe(s.stored);
  });

  it('report-route/overlay-served: imported findings are in the served Report with the verdicts recomputed', async () => {
    const s = await seeded();
    importInto(s, [imported()]);
    const { report: r } = await served(s);
    expect(r.findings).toEqual([
      expect.objectContaining({ title: 'Rate read before it is set', file: TAX, symbolId: 's-rate', state: 'open', sources: ['claude'] }),
    ]);
    expect(verdictOf(r, TAX)).toBe('risky');
    expect(r.summary.byVerdict).toEqual({ eyes: 1, risky: 1, spec: 0, ok: 0, same: 1 });
    // Everything else is the stored Report.
    const stored = JSON.parse(s.stored) as Report;
    expect({ ...r, findings: [], packages: [], summary: { ...r.summary, byVerdict: {} } }).toEqual({
      ...stored,
      findings: [],
      packages: [],
      summary: { ...stored.summary, byVerdict: {} },
    });
  });

  it('report-route/cache-invalidated-by-findings-write: a cached Report is served again until a findings write, then recomputed', async () => {
    const s = await seeded();
    const finding = imported();
    importInto(s, [finding]);
    const first = await served(s);
    expect((await served(s)).text).toBe(first.text);

    expect((await call(s.port, 'PUT', path(s, `/findings/${finding.key}/state`), { body: { state: 'intended' } })).status).toBe(200);
    const after = await served(s);
    expect(after.report.findings[0]?.state).toBe('intended');
    expect(verdictOf(after.report, TAX)).toBe('ok');

    // A new snapshot misses too, even with the findings unchanged.
    const head = sha();
    s.db.snapshots.put(
      snapshotInput(s.change.id, head, { report: JSON.stringify(report({ head })), fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h2', computedAt: '2026-09-03T00:00:00.000Z' }),
    );
    expect((await served(s)).report.meta.head).toBe(head);
  });
});

describe('findings-api', () => {
  it('findings-api/state-roundtrip: intended then open on an imported finding, merged parts included', async () => {
    const s = await seeded();
    const first = imported();
    const second = imported({ source: 'semgrep', line: 4, severity: 'med', title: 'rate read before it is set.' });
    importInto(s, [first, second]);

    const intended = await call(s.port, 'PUT', path(s, `/findings/${second.key}/state`), { body: { state: 'intended' } });
    expect(intended.status).toBe(200);
    expect(intended.json()).toEqual({ key: second.key, state: 'intended', keys: [first.key, second.key] });
    expect(s.db.findings.list(s.change.id).map((f) => f.finding.state)).toEqual(['intended', 'intended']);
    let r = (await served(s)).report;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ id: first.key, state: 'intended', sources: ['claude', 'semgrep'] });

    const open = await call(s.port, 'PUT', path(s, `/findings/${first.key}/state`), { body: { state: 'open' } });
    expect(open.json()).toEqual({ key: first.key, state: 'open', keys: [first.key, second.key] });
    r = (await served(s)).report;
    expect(r.findings[0]?.state).toBe('open');
    expect(verdictOf(r, TAX)).toBe('risky');

    // The write is a coalesced `review` event and the change's last event; never an `import` one.
    const events = s.db.events.listForRepo(s.repoId).map((e) => e.type);
    expect(events.filter((t) => t === 'review')).toHaveLength(1);
    expect(events).not.toContain('import');
    expect(s.db.changes.get(s.change.id)?.lastEventType).toBe('review');
  });

  it('findings-api/state-roundtrip: bad bodies, unknown keys and a change without a snapshot', async () => {
    const s = await seeded();
    importInto(s, [imported()]);
    for (const body of [{}, { state: 'fixed' }, { state: 'INTENDED' }, []]) {
      const answer = await call(s.port, 'PUT', path(s, `/findings/${imported().key}/state`), { body });
      expect([answer.status, errorCode(answer)]).toEqual([400, 'bad-request']);
    }
    const unknown = await call(s.port, 'PUT', path(s, '/findings/f:ffffffffffffffff/state'), { body: { state: 'intended' } });
    expect([unknown.status, errorCode(unknown)]).toEqual([404, 'finding-not-found']);
    const missing = await call(s.port, 'PUT', '/api/changes/999/findings/f:ffffffffffffffff/state', { body: { state: 'intended' } });
    expect([missing.status, errorCode(missing)]).toEqual([404, 'not-found']);
  });

  it('findings-api/rule-state-sticks-after-collect: a rule finding marked intended stays intended on the next snapshot', async () => {
    const s = await seeded({ rule: true });
    const answer = await call(s.port, 'PUT', path(s, `/findings/${encodeURIComponent(RULE.id)}/state`), { body: { state: 'intended' } });
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ key: RULE.id, state: 'intended', keys: [RULE.id] });
    expect(verdictOf((await served(s)).report, TAX)).toBe('ok');

    // The next collection recomputes the rule findings: same id, new head, new content.
    const head = sha();
    const next = JSON.stringify(report({ rule: true, head }));
    expect(
      s.db.snapshots.put(snapshotInput(s.change.id, head, { report: next, fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h2', computedAt: '2026-09-03T00:00:00.000Z' })),
    ).toBe('created');
    const after = (await served(s)).report;
    expect(after.meta.head).toBe(head);
    expect(after.findings).toEqual([{ ...RULE, state: 'intended' }]);
    expect(verdictOf(after, TAX)).toBe('ok');

    // Undo: open removes the rule state, and the stored string is served again.
    await call(s.port, 'PUT', path(s, `/findings/${RULE.id}/state`), { body: { state: 'open' } });
    expect((await served(s)).text).toBe(next);
  });

  it('findings-api/cross-site-403: every findings and approve write needs the daemon origin', async () => {
    const s = await seeded({ rule: true, worktree: true });
    const writes: [string, string, unknown][] = [
      ['PUT', path(s, `/findings/${RULE.id}/state`), { state: 'intended' }],
      ['POST', path(s, `/findings/${RULE.id}/fix`), undefined],
      ['POST', path(s, '/approve'), undefined],
      ['DELETE', path(s, '/approve'), undefined],
    ];
    const hostile = [
      { origin: 'http://evil.example', 'content-type': 'application/json' },
      { origin: `http://127.0.0.1:${String(s.port)}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
    ];
    for (const [method, url, body] of writes) {
      for (const headers of hostile) {
        const answer = await call(s.port, method, url, { body: body ?? {}, headers });
        expect([method, url, answer.status, errorCode(answer)]).toEqual([method, url, 403, 'cross-site']);
      }
    }
    expect(s.db.findings.hasAny(s.change.id)).toBe(false);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');
    expect(() => readFileSync(join(s.change.worktreePath ?? '', '.diffcity', 'fix-queue.json'))).toThrow();
  });

  it('findings-api/archived-409: an archived change takes no state, no fix and no approval', async () => {
    const s = await seeded({ rule: true, archived: true, worktree: true });
    for (const [method, url, body] of [
      ['PUT', path(s, `/findings/${RULE.id}/state`), { state: 'intended' }],
      ['POST', path(s, `/findings/${RULE.id}/fix`), undefined],
      ['POST', path(s, '/approve'), undefined],
      ['DELETE', path(s, '/approve'), undefined],
    ] as const) {
      const answer = await call(s.port, method, url, body === undefined ? {} : { body });
      expect([method, url, answer.status, errorCode(answer)]).toEqual([method, url, 409, 'archived']);
    }
    expect(s.db.findings.hasAny(s.change.id)).toBe(false);
  });
});

describe('fix-queue route', () => {
  it('queues the served finding into the working tree, once per key', async () => {
    const s = await seeded({ worktree: true });
    const finding = imported();
    importInto(s, [finding]);
    const first = await call(s.port, 'POST', path(s, `/findings/${finding.key}/fix`));
    expect(first.status).toBe(200);
    expect(first.json()).toEqual({ key: finding.key, queued: true, count: 1 });
    const again = await call(s.port, 'POST', path(s, `/findings/${finding.key}/fix`));
    expect(again.json()).toEqual({ key: finding.key, queued: false, count: 1 });
    const queue = JSON.parse(readFileSync(join(s.change.worktreePath ?? '', '.diffcity', 'fix-queue.json'), 'utf8')) as unknown;
    expect(queue).toEqual({
      version: 1,
      items: [
        {
          key: finding.key,
          file: TAX,
          line: 3,
          symbol: 'taxRate',
          severity: 'high',
          title: 'Rate read before it is set',
          message: 'taxRate reads the rate before the config loads.',
          fix: 'Load the config first.',
          queuedAt: expect.any(String) as string,
        },
      ],
    });
    await waitFor(() => s.test.events().some((e) => e.event === 'findings'), 5000, 'the findings signal');
  });

  it('fix-queue/no-working-tree-refused: a PR that is not checked out cannot queue', async () => {
    const s = await seeded({ rule: true, kind: 'pr' });
    const answer = await call(s.port, 'POST', path(s, `/findings/${RULE.id}/fix`));
    expect([answer.status, errorCode(answer)]).toEqual([409, 'no-working-tree']);
  });

  it('fix-queue/symlink-dir-refused over HTTP: fix-queue-unsafe', async () => {
    const s = await seeded({ rule: true, worktree: true });
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-else-'));
    dirs.push(elsewhere);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(elsewhere, join(s.change.worktreePath ?? '', '.diffcity'), 'dir');
    const answer = await call(s.port, 'POST', path(s, `/findings/${RULE.id}/fix`));
    expect([answer.status, errorCode(answer)]).toEqual([409, 'fix-queue-unsafe']);
  });
});

describe('approve', () => {
  it('approve/refused-without-tier1-marks: 409 until the tier 1 file has a current mark, then approved; DELETE returns to in-review', async () => {
    const s = await seeded();
    const refused = await call(s.port, 'POST', path(s, '/approve'));
    expect([refused.status, errorCode(refused)]).toEqual([409, 'tier1-unchecked']);
    expect((refused.json() as ApiError).error.message).toContain(TOTAL);
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('unreviewed');

    const snapshotId = s.db.snapshots.latest(s.change.id)?.id;
    const mark = await call(s.port, 'PUT', path(s, '/review/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-total' }, mark: 'checked' } });
    expect(mark.status).toBe(200);

    const ok = await call(s.port, 'POST', path(s, '/approve'));
    expect(ok.status).toBe(200);
    const body = ok.json() as { reviewState: string; approvedHead: string; approvedAt: string };
    expect(body).toMatchObject({ reviewState: 'approved', approvedHead: s.change.head });
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('approved');
    expect(s.db.changes.approval(s.change.id)).toEqual({ approvedHead: s.change.head, approvedAt: body.approvedAt });
    // Approving again changes nothing.
    expect((await call(s.port, 'POST', path(s, '/approve'))).json()).toEqual(body);

    const undo = await call(s.port, 'DELETE', path(s, '/approve'));
    expect(undo.json()).toEqual({ reviewState: 'in-review', approvedHead: null, approvedAt: null });
    expect(s.db.changes.get(s.change.id)?.reviewState).toBe('in-review');
    const twice = await call(s.port, 'DELETE', path(s, '/approve'));
    expect([twice.status, errorCode(twice)]).toEqual([409, 'not-approved']);
    await waitFor(() => s.test.events().some((e) => e.event === 'review' && e.data['changeId'] === s.change.id), 5000, 'the review signal');
  });

  it('approve/server-recheck-ignores-client: a body claiming the marks or forcing the approval changes nothing', async () => {
    const s = await seeded();
    for (const body of [{ force: true }, { tier1Checked: true, marks: [{ targetKind: 'file', targetId: 'f-total', state: 'current' }] }, { reviewState: 'approved' }]) {
      const answer = await call(s.port, 'POST', path(s, '/approve'), { body });
      expect([answer.status, errorCode(answer)]).toEqual([409, 'tier1-unchecked']);
    }
    // An outdated mark does not count either.
    const snapshotId = s.db.snapshots.latest(s.change.id)?.id ?? 0;
    await call(s.port, 'PUT', path(s, '/review/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-total' }, mark: 'good' } });
    s.db.review.markOutdated(s.change.id, [{ kind: 'file', id: 'f-total' }], '2026-09-04T00:00:00.000Z');
    const outdated = await call(s.port, 'POST', path(s, '/approve'), { body: { force: true } });
    expect([outdated.status, errorCode(outdated)]).toEqual([409, 'tier1-unchecked']);
    expect(s.db.changes.get(s.change.id)?.reviewState).not.toBe('approved');
  });

  it('a change whose head moved past its latest snapshot is not approved yet', async () => {
    const s = await seeded();
    const snapshotId = s.db.snapshots.latest(s.change.id)?.id;
    await call(s.port, 'PUT', path(s, '/review/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-total' }, mark: 'checked' } });
    s.db.changes.applyPlan(s.repoId, { create: [], update: [{ id: s.change.id, head: sha() }], archive: [] }, T0);
    const answer = await call(s.port, 'POST', path(s, '/approve'));
    expect([answer.status, errorCode(answer)]).toEqual([409, 'snapshot-pending']);
  });
});

describe('sse/findings-event', () => {
  it('a state write signals `findings` (and `changes`) for the change', async () => {
    const s = await seeded({ rule: true });
    await call(s.port, 'PUT', path(s, `/findings/${RULE.id}/state`), { body: { state: 'intended' } });
    await waitFor(
      () => s.test.events().some((e) => e.event === 'findings' && e.data['changeId'] === s.change.id && e.data['repoId'] === s.repoId),
      5000,
      'the findings signal',
    );
    expect(s.test.events().some((e) => e.event === 'changes' && e.data['repoId'] === s.repoId)).toBe(true);
  });

  it('an import stored through the daemon helper signals `findings`', async () => {
    const s = await seeded();
    importInto(s, [imported()]);
    await waitFor(() => s.test.events().some((e) => e.event === 'findings' && e.data['changeId'] === s.change.id), 5000, 'the findings signal');
  });
});
