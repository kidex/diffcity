// Edge cases of the findings actions, Approve and the served Report (ADR-036)
// over HTTP: concurrent writes, odd keys in the URL, malformed bodies, Approve
// against a snapshot that lands later, the fix queue on unusual working trees,
// a finding whose file left the change, and the served cache across changes.
// An in-process daemon, a temporary DIFFCITY_HOME and invented data.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { anchor, type StoredFinding } from '../../../src/core/findings/index.js';
import type { ApiError, ChangeRecord } from '../../../src/core/model/types.js';
import type { Finding, Report } from '../../../src/core/report/types.js';
import { FINDING_KEY_MAX } from '../../../src/daemon/api/findings.js';
import { createServedCache, SERVED_CACHE_MAX, type ServedCache } from '../../../src/daemon/api/served-cache.js';
import { storeFindingsImport } from '../../../src/daemon/findings.js';
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

const RULE: Finding = {
  id: 'rule:size:00bb',
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

function report(options: { head: string; rule?: boolean; withoutTax?: boolean }): Report {
  const base = sampleReport();
  const packages = base.packages.map((pkg) => ({
    ...pkg,
    files: pkg.files.filter((file) => !(options.withoutTax === true && file.path === TAX)),
  }));
  return {
    ...base,
    meta: { ...base.meta, head: options.head },
    packages,
    findings: options.rule === true ? [RULE] : [],
    summary: { ...base.summary, tier1Files: [TOTAL] },
  };
}

interface World {
  test: TestDaemon;
  db: Db;
  port: number;
  repoId: number;
}

async function world(servedCache?: ServedCache): Promise<World> {
  const test = await startTestDaemon({}, { api: true, ...(servedCache === undefined ? {} : { servedCache }) });
  const db = test.collection.db();
  const repo = addRepo(db);
  return { test, db, port: test.daemon.info.port, repoId: repo.id };
}

function addChange(w: World, name: string, options: { rule?: boolean; worktree?: boolean } = {}): ChangeRecord {
  let worktreePath: string | null = null;
  if (options.worktree === true) {
    worktreePath = mkdtempSync(join(tmpdir(), 'dc-edge-tree-'));
    dirs.push(worktreePath);
  }
  const change = w.db.changes.applyPlan(w.repoId, { create: [branchFields(name, { worktreePath })], update: [], archive: [] }, T0).created[0];
  if (change === undefined) throw new Error('no change');
  w.db.snapshots.put(
    snapshotInput(change.id, change.head, {
      report: JSON.stringify(report({ head: change.head, rule: options.rule ?? false })),
      fingerprints: JSON.stringify(sampleFingerprints()),
      contentHash: `h-${name}`,
    }),
  );
  return change;
}

function finding(title = 'Rate read before it is set', message = 'taxRate reads the rate before the config loads.'): StoredFinding {
  const result = anchor(
    { source: 'claude', severity: 'high', category: 'correctness', file: TAX, line: 3, title, message, fix: 'Load the config first.' },
    sampleReport(),
    sampleFingerprints(),
  );
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

function importInto(w: World, change: ChangeRecord, findings: StoredFinding[]): void {
  storeFindingsImport({ db: w.db, broadcast: () => undefined }, w.repoId, { changeId: change.id, head: change.head, findings, fixed: [], at: T0 });
}

const url = (change: ChangeRecord, rest: string): string => `/api/changes/${String(change.id)}${rest}`;
const codeOf = (answer: { json(): unknown }): string => (answer.json() as ApiError).error.code;

async function markTier1(w: World, change: ChangeRecord): Promise<void> {
  const snapshotId = w.db.snapshots.latest(change.id)?.id;
  const answer = await call(w.port, 'PUT', url(change, '/review/marks'), { body: { snapshotId, target: { kind: 'file', id: 'f-total' }, mark: 'checked' } });
  expect(answer.status).toBe(200);
}

describe('findings actions under concurrency', () => {
  it('two state writes at once on the same finding both answer and leave one consistent state', async () => {
    const w = await world();
    const change = addChange(w, 'concurrent-state', { rule: true });
    const f = finding();
    importInto(w, change, [f]);
    const [a, b, c, d] = await Promise.all([
      call(w.port, 'PUT', url(change, `/findings/${f.key}/state`), { body: { state: 'intended' } }),
      call(w.port, 'PUT', url(change, `/findings/${f.key}/state`), { body: { state: 'intended' } }),
      call(w.port, 'PUT', url(change, `/findings/${RULE.id}/state`), { body: { state: 'intended' } }),
      call(w.port, 'PUT', url(change, `/findings/${RULE.id}/state`), { body: { state: 'intended' } }),
    ]);
    expect([a.status, b.status, c.status, d.status]).toEqual([200, 200, 200, 200]);
    expect(w.db.findings.get(change.id, f.key)?.finding.state).toBe('intended');
    expect(w.db.findings.ruleStates(change.id)).toEqual({ [RULE.id]: 'intended' });
    const served = JSON.parse((await call(w.port, 'GET', url(change, '/report'))).text) as Report;
    expect(served.findings.map((x) => [x.id, x.state]).sort()).toEqual([
      [f.key, 'intended'],
      [RULE.id, 'intended'],
    ].sort());
  });

  it('two approvals at once: both 200 with the same approval, one approved state', async () => {
    const w = await world();
    const change = addChange(w, 'concurrent-approve');
    await markTier1(w, change);
    const answers = await Promise.all([call(w.port, 'POST', url(change, '/approve')), call(w.port, 'POST', url(change, '/approve'))]);
    expect(answers.map((x) => x.status)).toEqual([200, 200]);
    const [first, second] = answers.map((x) => x.json() as { approvedAt: string; approvedHead: string });
    expect(second).toEqual(first);
    expect(w.db.changes.approval(change.id)).toEqual({ approvedHead: change.head, approvedAt: first?.approvedAt });
    expect(w.db.changes.get(change.id)?.reviewState).toBe('approved');
  });

  it('approve and DELETE approve at once end in one of the two states, with matching columns', async () => {
    const w = await world();
    const change = addChange(w, 'approve-race');
    await markTier1(w, change);
    expect((await call(w.port, 'POST', url(change, '/approve'))).status).toBe(200);
    await Promise.all([call(w.port, 'DELETE', url(change, '/approve')), call(w.port, 'POST', url(change, '/approve'))]);
    const state = w.db.changes.get(change.id)?.reviewState;
    const approval = w.db.changes.approval(change.id);
    if (state === 'approved') expect(approval?.approvedHead).toBe(change.head);
    else expect([state, approval]).toEqual(['in-review', { approvedHead: null, approvedAt: null }]);
  });

  it('two fix requests at once for different keys both land in the queue', async () => {
    const w = await world();
    const change = addChange(w, 'concurrent-fix', { rule: true, worktree: true });
    const f = finding();
    importInto(w, change, [f]);
    const answers = await Promise.all([
      call(w.port, 'POST', url(change, `/findings/${f.key}/fix`)),
      call(w.port, 'POST', url(change, `/findings/${RULE.id}/fix`)),
    ]);
    expect(answers.map((x) => x.status)).toEqual([200, 200]);
    const queue = JSON.parse(readFileSync(join(change.worktreePath ?? '', '.diffcity', 'fix-queue.json'), 'utf8')) as { items: { key: string }[] };
    expect(queue.items.map((i) => i.key).sort()).toEqual([f.key, RULE.id].sort());
  });
});

describe('odd keys in the URL', () => {
  it('an encoded slash, dot segments and unknown keys are refused without a write', async () => {
    const w = await world();
    const change = addChange(w, 'odd-keys', { worktree: true });
    importInto(w, change, [finding()]);
    for (const key of ['f%2F..%2F..%2Fetc', '..', '%2E%2E', '%2E%2E%2F%2E%2E', 'f:0000000000000000', '%00', 'f%3A%2F%2F']) {
      for (const [method, rest, body] of [
        ['PUT', '/state', { state: 'intended' }],
        ['POST', '/fix', undefined],
      ] as const) {
        const answer = await call(w.port, method, url(change, `/findings/${key}${rest}`), body === undefined ? {} : { body });
        expect([key, method, answer.status >= 400 && answer.status < 500]).toEqual([key, method, true]);
      }
    }
    expect(w.db.findings.list(change.id).every((s) => s.finding.state === 'open')).toBe(true);
    expect(w.db.findings.ruleStates(change.id)).toEqual({});
    expect(() => readFileSync(join(change.worktreePath ?? '', '.diffcity', 'fix-queue.json'))).toThrow();
  });

  it('a long key gets the route answer of FINDING_KEY_MAX in the ADR-017 error shape', async () => {
    const w = await world();
    const change = addChange(w, 'long-key');
    const put = (key: string): ReturnType<typeof call> =>
      call(w.port, 'PUT', url(change, `/findings/${key}/state`), { body: { state: 'intended' } });
    // Up to FINDING_KEY_MAX characters a key reaches the route: an unknown one is `finding-not-found`.
    for (const length of [101, 200, FINDING_KEY_MAX]) {
      const answer = await put('k'.repeat(length));
      expect([length, answer.status, codeOf(answer)]).toEqual([length, 404, 'finding-not-found']);
    }
    // Past it the route refuses it as `bad-request`.
    const over = await put('k'.repeat(FINDING_KEY_MAX + 1));
    expect([over.status, codeOf(over)]).toEqual([400, 'bad-request']);
    // Whatever the length, a 4xx in the `{ error: { code, message } }` shape, never a 5xx.
    const huge = await put('k'.repeat(5000));
    expect(huge.status >= 400 && huge.status < 500).toBe(true);
    expect(typeof (huge.json() as ApiError).error.code).toBe('string');
    expect(w.db.findings.hasAny(change.id)).toBe(false);
  });

  it('a non-numeric or negative change id is 400 or 404', async () => {
    const w = await world();
    for (const id of ['abc', '-1', '1.5', '99999999999999999999']) {
      const answer = await call(w.port, 'POST', `/api/changes/${id}/approve`);
      expect([id, [400, 404].includes(answer.status)]).toEqual([id, true]);
    }
  });
});

describe('PUT state bodies', () => {
  it('wrong types are 400 and write nothing', async () => {
    const w = await world();
    const change = addChange(w, 'bodies');
    const f = finding();
    importInto(w, change, [f]);
    const bodies: unknown[] = [{ state: 1 }, { state: ['intended'] }, { state: null }, { state: 'fixed' }, { state: 'INTENDED' }, { State: 'intended' }, [], 'intended', '"intended"', 'null', '{"state":"intended"'];
    for (const body of bodies) {
      const answer = await call(w.port, 'PUT', url(change, `/findings/${f.key}/state`), { body });
      expect([body, answer.status]).toEqual([body, 400]);
    }
    expect(w.db.findings.get(change.id, f.key)?.finding.state).toBe('open');
  });

  it('extra fields are ignored: only the state is written', async () => {
    const w = await world();
    const change = addChange(w, 'extra-fields');
    const f = finding();
    importInto(w, change, [f]);
    const answer = await call(w.port, 'PUT', url(change, `/findings/${f.key}/state`), {
      body: { state: 'intended', severity: 'low', file: 'src/elsewhere.ts', key: 'f:ffffffffffffffff', title: 'changed' },
    });
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ key: f.key, state: 'intended', keys: [f.key] });
    const stored = w.db.findings.get(change.id, f.key);
    expect(stored?.finding).toMatchObject({ severity: 'high', file: TAX, title: 'Rate read before it is set', state: 'intended' });
  });
});

describe('approve lifecycle', () => {
  it('DELETE approve then a new approve sets a new approvedAt on the current head', async () => {
    let clock = Date.parse('2026-10-07T09:00:00.000Z');
    const test = await startTestDaemon({}, { api: true, apiNow: () => new Date((clock += 60_000)) });
    const w: World = { test, db: test.collection.db(), port: test.daemon.info.port, repoId: addRepo(test.collection.db()).id };
    const change = addChange(w, 'reapprove');
    await markTier1(w, change);
    const first = (await call(w.port, 'POST', url(change, '/approve'))).json() as { approvedAt: string };
    expect((await call(w.port, 'DELETE', url(change, '/approve'))).status).toBe(200);
    expect(w.db.changes.approval(change.id)).toEqual({ approvedHead: null, approvedAt: null });
    const second = await call(w.port, 'POST', url(change, '/approve'));
    expect(second.status).toBe(200);
    const body = second.json() as { reviewState: string; approvedHead: string; approvedAt: string };
    expect(body).toMatchObject({ reviewState: 'approved', approvedHead: change.head });
    expect(body.approvedAt > first.approvedAt).toBe(true);
    expect(w.db.changes.approval(change.id)).toEqual({ approvedHead: change.head, approvedAt: body.approvedAt });
  });

  it('approve while a collect is running: the snapshot that lands after it with new content returns the change to unreviewed', async () => {
    // The head moved and its snapshot is still being computed: Approve waits.
    const w = await world();
    const change = addChange(w, 'collect-running');
    await markTier1(w, change);
    const newHead = sha();
    w.db.changes.applyPlan(w.repoId, { create: [], update: [{ id: change.id, head: newHead }], archive: [] }, T0);
    const pending = await call(w.port, 'POST', url(change, '/approve'));
    expect([pending.status, codeOf(pending)]).toEqual([409, 'snapshot-pending']);
    expect(w.db.changes.get(change.id)?.reviewState).not.toBe('approved');
    expect(w.db.changes.approval(change.id)).toEqual({ approvedHead: null, approvedAt: null });
  });
});

describe('fix queue on unusual working trees over HTTP', () => {
  it('.diffcity as a regular file is fix-queue-unsafe and the file is untouched', async () => {
    const w = await world();
    const change = addChange(w, 'dot-file', { rule: true, worktree: true });
    const dot = join(change.worktreePath ?? '', '.diffcity');
    writeFileSync(dot, 'not a directory\n');
    const answer = await call(w.port, 'POST', url(change, `/findings/${RULE.id}/fix`));
    expect([answer.status, codeOf(answer)]).toEqual([409, 'fix-queue-unsafe']);
    expect(readFileSync(dot, 'utf8')).toBe('not a directory\n');
  });

  it('an existing queue of another version is fix-queue-invalid and left as it is', async () => {
    const w = await world();
    const change = addChange(w, 'other-version', { rule: true, worktree: true });
    mkdirSync(join(change.worktreePath ?? '', '.diffcity'));
    const file = join(change.worktreePath ?? '', '.diffcity', 'fix-queue.json');
    const content = '{"version":2,"items":[{"key":"f:1111111111111111"}]}';
    writeFileSync(file, content);
    const answer = await call(w.port, 'POST', url(change, `/findings/${RULE.id}/fix`));
    expect([answer.status, codeOf(answer)]).toEqual([409, 'fix-queue-invalid']);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('a queue grown past 1 MiB by long messages is refused with fix-queue-full and stays under the cap', async () => {
    const w = await world();
    const change = addChange(w, 'big-queue', { worktree: true });
    // Long imported messages (each well under any per-finding cap) fill the queue.
    const long = 'm'.repeat(200 * 1024);
    const findings = Array.from({ length: 8 }, (_, n) => finding(`Long finding ${String(n)}`, `${long}${String(n)}`));
    importInto(w, change, findings);
    const codes: (string | number)[] = [];
    for (const f of findings) {
      const answer = await call(w.port, 'POST', url(change, `/findings/${f.key}/fix`));
      codes.push(answer.status === 200 ? 200 : codeOf(answer));
    }
    expect(codes.filter((c) => c === 200).length).toBe(5);
    expect(codes.slice(5)).toEqual(['fix-queue-full', 'fix-queue-full', 'fix-queue-full']);
    const text = readFileSync(join(change.worktreePath ?? '', '.diffcity', 'fix-queue.json'));
    expect(text.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect((JSON.parse(text.toString('utf8')) as { items: unknown[] }).items).toHaveLength(5);
  });
});

describe('served Report with a finding whose file left the change', () => {
  it('the finding is not served, the verdicts are those of the new Report, and its state can still be set', async () => {
    const w = await world();
    const change = addChange(w, 'file-left');
    const f = finding();
    importInto(w, change, [f]);
    const before = JSON.parse((await call(w.port, 'GET', url(change, '/report'))).text) as Report;
    expect(before.findings.map((x) => x.id)).toEqual([f.key]);

    const head = sha();
    w.db.snapshots.put(
      snapshotInput(change.id, head, {
        report: JSON.stringify(report({ head, withoutTax: true })),
        fingerprints: JSON.stringify(sampleFingerprints()),
        contentHash: 'h-left',
        computedAt: '2026-09-03T00:00:00.000Z',
      }),
    );
    const answer = await call(w.port, 'GET', url(change, '/report'));
    expect(answer.status).toBe(200);
    const after = JSON.parse(answer.text) as Report;
    expect(after.meta.head).toBe(head);
    expect(after.findings).toEqual([]);
    const files = after.packages.flatMap((p) => p.files);
    expect(files.map((x) => x.path)).not.toContain(TAX);
    const counted = Object.values(after.summary.byVerdict).reduce((a, b) => a + b, 0);
    expect(counted).toBe(files.length);

    const state = await call(w.port, 'PUT', url(change, `/findings/${f.key}/state`), { body: { state: 'intended' } });
    expect(state.status).toBe(200);
    expect(w.db.findings.get(change.id, f.key)?.finding.state).toBe('intended');
  });
});

describe('served cache across changes', () => {
  it('two changes keep separate entries: a write on one does not miss the other', async () => {
    const cache = createServedCache();
    const w = await world(cache);
    const a = addChange(w, 'cache-a');
    const b = addChange(w, 'cache-b');
    const fa = finding('Finding on A');
    const fb = finding('Finding on B');
    importInto(w, a, [fa]);
    importInto(w, b, [fb]);
    const ra = (await call(w.port, 'GET', url(a, '/report'))).text;
    const rb = (await call(w.port, 'GET', url(b, '/report'))).text;
    expect((JSON.parse(ra) as Report).findings.map((x) => x.title)).toEqual(['Finding on A']);
    expect((JSON.parse(rb) as Report).findings.map((x) => x.title)).toEqual(['Finding on B']);
    expect(cache.stats).toEqual({ hits: 0, misses: 2 });

    expect((await call(w.port, 'PUT', url(a, `/findings/${fa.key}/state`), { body: { state: 'intended' } })).status).toBe(200);
    expect((await call(w.port, 'GET', url(b, '/report'))).text).toBe(rb);
    expect(cache.stats).toEqual({ hits: 1, misses: 2 });
    const ra2 = JSON.parse((await call(w.port, 'GET', url(a, '/report'))).text) as Report;
    expect(ra2.findings[0]?.state).toBe('intended');
    expect(cache.stats).toEqual({ hits: 1, misses: 3 });
  });

  it('more than SERVED_CACHE_MAX changes evict the least recently used, and every answer stays correct', async () => {
    const cache = createServedCache();
    const w = await world(cache);
    const changes = Array.from({ length: SERVED_CACHE_MAX + 2 }, (_, n) => addChange(w, `evict-${String(n)}`));
    for (const [n, change] of changes.entries()) importInto(w, change, [finding(`Finding ${String(n)}`)]);
    for (const change of changes) expect((await call(w.port, 'GET', url(change, '/report'))).status).toBe(200);
    expect(cache.size).toBe(SERVED_CACHE_MAX);
    expect(cache.stats).toEqual({ hits: 0, misses: SERVED_CACHE_MAX + 2 });

    // The two oldest were evicted: they miss; the newest hits.
    const last = changes[changes.length - 1];
    const first = changes[0];
    if (last === undefined || first === undefined) throw new Error('no changes');
    await call(w.port, 'GET', url(last, '/report'));
    expect(cache.stats.hits).toBe(1);
    const again = JSON.parse((await call(w.port, 'GET', url(first, '/report'))).text) as Report;
    expect(again.findings.map((x) => x.title)).toEqual(['Finding 0']);
    expect(cache.stats.misses).toBe(SERVED_CACHE_MAX + 3);
    expect(cache.size).toBe(SERVED_CACHE_MAX);
    for (const [n, change] of changes.entries()) {
      const served = JSON.parse((await call(w.port, 'GET', url(change, '/report'))).text) as Report;
      expect(served.findings.map((x) => x.title)).toEqual([`Finding ${String(n)}`]);
    }
  });
});
