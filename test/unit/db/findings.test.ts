// The findings store (ADR-036, schema v3): imported findings in import order,
// merged on a repeated key, closed by `fixed` keys, rule-finding states as
// `rule-state` rows, the per-change version, and the cascade with the change.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/core/db/index.js';
import { anchor, type FindingInput, type StoredFinding } from '../../../src/core/findings/index.js';
import { shopfrontFingerprints, shopfrontReport } from '../findings/support.js';
import { addRepo, branchFields, daysAfter, rawConnection, sha, snapshotInput, T0, tempDb, type TempDb } from './db-helpers.js';

let temp: TempDb;
let db: Db;
let changeId: number;
let repoId: number;
let head: string;

beforeEach(() => {
  temp = tempDb();
  db = temp.db;
  const repo = addRepo(db);
  repoId = repo.id;
  const change = db.changes.applyPlan(repo.id, { create: [branchFields('cancel')], update: [], archive: [] }, T0).created[0];
  if (change === undefined) throw new Error('no change');
  changeId = change.id;
  head = change.head;
});
afterEach(() => {
  temp.cleanup();
});

const GUARD = 'src/auth/order.guard.ts';
const ORDERS = 'src/orders/orders.service.ts';

function input(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    source: 'claude',
    severity: 'high',
    category: 'security',
    file: GUARD,
    line: 14,
    title: 'Optional order defaults to allow',
    message: 'When order is undefined the guard returns true.',
    ...overrides,
  };
}

function anchored(overrides: Partial<FindingInput> = {}): StoredFinding {
  const result = anchor(input(overrides), shopfrontReport(), shopfrontFingerprints());
  if (!result.ok) throw new Error('not anchored');
  return result.stored;
}

describe('findings store', () => {
  it('stores a batch in import order and reads back the StoredFinding, anchor included', () => {
    const a = anchored({ id: 'guard-1', why: 'new guard, called without an order' });
    const b = anchored({ file: ORDERS, line: 12, title: 'Cancel ignores refunds', category: 'correctness', severity: 'med' });
    expect(db.findings.hasAny(changeId)).toBe(false);
    const result = db.findings.importBatch({ changeId, head, findings: [b, a], fixed: [], at: T0 });
    expect(result).toMatchObject({ inserted: 2, updated: 0, fixed: 0 });
    expect(result.version).toBeGreaterThan(0);
    expect(db.findings.list(changeId)).toEqual([b, a]);
    expect(db.findings.get(changeId, a.key)).toEqual(a);
    expect(a.anchor).toMatchObject({ symbolName: 'canCancel', symbolKind: 'function', symbolStart: 10, fingerprint: 'sym-guard' });
    expect(db.findings.hasAny(changeId)).toBe(true);
  });

  it('liveChangesWithAny: the live changes of the repo with an imported finding or a rule state, by id (DC-106)', () => {
    const { created } = db.changes.applyPlan(repoId, { create: [branchFields('rule-only'), branchFields('quiet'), branchFields('gone')], update: [], archive: [] }, T0);
    const [ruleOnly, quiet, gone] = created;
    if (ruleOnly === undefined || quiet === undefined || gone === undefined) throw new Error('no changes');
    const other = addRepo(db, 'other-shop');
    const foreign = db.changes.applyPlan(other.id, { create: [branchFields('foreign')], update: [], archive: [] }, T0).created[0];
    if (foreign === undefined) throw new Error('no change');
    expect(db.findings.liveChangesWithAny(repoId)).toEqual([]);

    db.findings.importBatch({ changeId, head, findings: [anchored(), anchored({ source: 'semgrep' })], fixed: [], at: T0 });
    db.findings.setRuleState(ruleOnly.id, 'rule:size:0001', ruleOnly.head, 'intended', T0);
    db.findings.importBatch({ changeId: gone.id, head: gone.head, findings: [anchored()], fixed: [], at: T0 });
    db.findings.importBatch({ changeId: foreign.id, head: foreign.head, findings: [anchored()], fixed: [], at: T0 });
    db.changes.applyPlan(repoId, { create: [], update: [], archive: [{ id: gone.id, reason: 'merged' }] }, T0);

    expect(db.findings.liveChangesWithAny(repoId)).toEqual([changeId, ruleOnly.id]);
    expect(db.findings.liveChangesWithAny(other.id)).toEqual([foreign.id]);
  });

  it('a repeated key keeps its place and an intended state, takes the new finding, and fixed closes only open rows', () => {
    const a = anchored();
    const b = anchored({ file: ORDERS, line: 12, title: 'Cancel ignores refunds' });
    const c = anchored({ file: ORDERS, line: 40, title: 'Refund rounds down' });
    db.findings.importBatch({ changeId, head, findings: [a, b, c], fixed: [], at: T0 });
    db.findings.setStates(changeId, [a.key], 'intended', daysAfter(T0, 1));

    const later = sha();
    const again = { ...a, finding: { ...a.finding, message: 'Still returns true.' } };
    const result = db.findings.importBatch({ changeId, head: later, findings: [again], fixed: [a.key, b.key], at: daysAfter(T0, 2) });
    expect(result).toMatchObject({ inserted: 0, updated: 1, fixed: 1 });
    const listed = db.findings.list(changeId);
    expect(listed.map((f) => [f.key, f.finding.state])).toEqual([
      [a.key, 'intended'],
      [b.key, 'fixed'],
      [c.key, 'open'],
    ]);
    expect(listed[0]?.finding.message).toBe('Still returns true.');
    const raw = rawConnection(temp.path, { readOnly: true });
    expect(raw.prepare('SELECT head FROM findings WHERE key = ?').get(a.key)).toEqual({ head: later });
    raw.close();
  });

  it('the version moves on every write and never repeats', () => {
    const v0 = db.findings.version(changeId);
    expect(v0).toBe(0);
    const a = anchored();
    db.findings.importBatch({ changeId, head, findings: [a], fixed: [], at: T0 });
    const v1 = db.findings.version(changeId);
    db.findings.setStates(changeId, [a.key], 'intended', T0);
    const v2 = db.findings.version(changeId);
    db.findings.setRuleState(changeId, 'rule:size:abc', head, 'intended', T0);
    const v3 = db.findings.version(changeId);
    expect(new Set([v0, v1, v2, v3]).size).toBe(4);
    // Nothing changed: no new version.
    db.findings.setStates(changeId, ['f:0000000000000000'], 'open', T0);
    expect(db.findings.version(changeId)).toBe(v3);
  });

  it('findings/purged-with-change: imported rows and rule states go with their purged change', () => {
    db.findings.importBatch({ changeId, head, findings: [anchored()], fixed: [], at: T0 });
    db.findings.setRuleState(changeId, 'rule:size:abc', head, 'intended', T0);
    db.changes.applyPlan(repoId, { create: [], update: [], archive: [{ id: changeId, reason: 'merged' }] }, T0);
    expect(db.purgeArchived(daysAfter(T0, 91))).toBe(1);
    const raw = rawConnection(temp.path, { readOnly: true });
    expect(raw.prepare('SELECT count(*) AS n FROM findings').get()).toEqual({ n: 0 });
    raw.close();
    expect(db.findings.list(changeId)).toEqual([]);
    expect(db.findings.ruleStates(changeId)).toEqual({});
  });

  it('findings/rule-state-row-survives-snapshot: the state of a rule finding outlives the snapshots', () => {
    db.snapshots.put(snapshotInput(changeId, head, { contentHash: 'h1' }));
    db.findings.setRuleState(changeId, 'rule:size:abc', head, 'intended', T0);
    const next = sha();
    expect(db.snapshots.put(snapshotInput(changeId, next, { contentHash: 'h2', computedAt: daysAfter(T0, 1) }))).toBe('created');
    expect(db.findings.ruleStates(changeId)).toEqual({ 'rule:size:abc': 'intended' });
    expect(db.findings.list(changeId)).toEqual([]);
    const raw = rawConnection(temp.path, { readOnly: true });
    expect(raw.prepare("SELECT origin, finding, state FROM findings WHERE key = 'rule:size:abc'").get()).toEqual({
      origin: 'rule-state',
      finding: '{"id":"rule:size:abc","state":"intended"}',
      state: 'intended',
    });
    raw.close();
    // Undo is `open`: the row goes, a rule finding is open by default.
    db.findings.setRuleState(changeId, 'rule:size:abc', next, 'open', T0);
    expect(db.findings.ruleStates(changeId)).toEqual({});
    expect(db.findings.hasAny(changeId)).toBe(false);
  });

  it('refuses a finding whose id is not its key', () => {
    const a = anchored();
    expect(() => db.findings.importBatch({ changeId, head, findings: [{ ...a, finding: { ...a.finding, id: 'other' } }], fixed: [], at: T0 })).toThrow(/has id/);
    expect(db.findings.list(changeId)).toEqual([]);
  });
});

describe('changes approval columns', () => {
  it('reads and writes approvedHead and approvedAt', () => {
    expect(db.changes.approval(changeId)).toEqual({ approvedHead: null, approvedAt: null });
    db.changes.setApproval(changeId, { approvedHead: head, approvedAt: T0 });
    expect(db.changes.approval(changeId)).toEqual({ approvedHead: head, approvedAt: T0 });
    db.changes.setApproval(changeId, { approvedHead: null, approvedAt: null });
    expect(db.changes.approval(changeId)).toEqual({ approvedHead: null, approvedAt: null });
    expect(db.changes.approval(9999)).toBeNull();
    expect(() => { db.changes.setApproval(9999, { approvedHead: null, approvedAt: null }); }).toThrow(/not found/);
  });
});
