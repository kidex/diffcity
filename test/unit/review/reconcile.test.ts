// The outdated rule of ADR-028 (src/core/review/reconcile.ts and apply.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileMarks, reconcileOnSnapshot } from '../../../src/core/review/index.js';
import { addRepo, branchFields, snapshotInput, tempDb, type TempDb } from '../db/db-helpers.js';
import { sampleFingerprints, storedMark, T } from './review-helpers.js';

describe('review/outdated-on-file-change', () => {
  it('a file mark whose after bytes changed becomes outdated, the others stay', () => {
    const before = sampleFingerprints();
    const marks = [storedMark(before, 'file', 'f-total'), storedMark(before, 'file', 'f-tax')];
    const after = sampleFingerprints({ files: { 'f-total': { before: 'b-total', after: 'a-total-2' } } });
    expect(reconcileMarks(marks, after)).toEqual([{ kind: 'file', id: 'f-total' }]);
  });
});

describe('review/outdated-on-symbol-change', () => {
  it('a symbol mark whose slice changed becomes outdated', () => {
    const before = sampleFingerprints();
    const marks = [storedMark(before, 'symbol', 's-total')];
    expect(reconcileMarks(marks, sampleFingerprints({ symbols: { 's-total': 'sym-total-2' } }))).toEqual([{ kind: 'symbol', id: 's-total' }]);
  });
});

describe('review/symbol-mark-survives-other-symbol-change', () => {
  it('changing a sibling symbol leaves this symbol mark current', () => {
    const before = sampleFingerprints();
    const marks = [storedMark(before, 'symbol', 's-total'), storedMark(before, 'symbol', 's-round')];
    expect(reconcileMarks(marks, sampleFingerprints({ symbols: { 's-round': 'sym-round-2' } }))).toEqual([{ kind: 'symbol', id: 's-round' }]);
  });
});

describe('review/outdated-on-base-move', () => {
  it('the before side changing alone resets the file mark', () => {
    const before = sampleFingerprints();
    const marks = [storedMark(before, 'file', 'f-total')];
    const after = sampleFingerprints({ files: { 'f-total': { before: 'b-total-moved', after: 'a-total' } } });
    expect(reconcileMarks(marks, after)).toEqual([{ kind: 'file', id: 'f-total' }]);
  });
});

describe('review/outdated-on-rename', () => {
  it('a target missing from the new fingerprints (renamed file, deleted symbol) becomes outdated', () => {
    const before = sampleFingerprints();
    const marks = [storedMark(before, 'file', 'f-total'), storedMark(before, 'symbol', 's-rate')];
    const files = { ...before.files };
    delete files['f-total'];
    files['f-total-renamed'] = { before: 'b-total', after: 'a-total', oldPath: 'src/cart/total.ts' };
    const symbols = { ...before.symbols };
    delete symbols['s-rate'];
    expect(reconcileMarks(marks, { files, symbols })).toEqual([
      { kind: 'file', id: 'f-total' },
      { kind: 'symbol', id: 's-rate' },
    ]);
  });
});

describe('review stored in a database', () => {
  let temp: TempDb;
  let changeId: number;
  beforeEach(() => {
    temp = tempDb();
    const repo = addRepo(temp.db);
    const change = temp.db.changes.applyPlan(repo.id, { create: [branchFields('cart')], update: [], archive: [] }, T).created[0];
    if (change === undefined) throw new Error('no change');
    changeId = change.id;
  });
  afterEach(() => {
    temp.cleanup();
  });

  // The stored fingerprint of a file mark is `<before>|<after>`.
  const mark = (fingerprint: string) =>
    temp.db.review.upsert({
      changeId,
      target: { kind: 'file', id: 'f-total' },
      filePath: 'src/cart/total.ts',
      mark: 'checked',
      note: null,
      lines: null,
      fingerprint,
      snapshotId: null,
      at: T,
    });
  const fingerprintsOf = (after: string): string => JSON.stringify({ files: { 'f-total': { before: 'b', after } }, symbols: {} });
  const marked = (after: string): string => `b|${after}`;
  const first = () => temp.db.review.list(changeId)[0];

  it('review/outdated-sticky-a-b-a: content returning to the marked bytes does not bring the mark back', () => {
    mark(marked('A'));
    expect(reconcileOnSnapshot(temp.db, changeId, 'replaced', fingerprintsOf('B'), '2026-09-01T11:00:00.000Z')).toBe(1);
    expect(first()?.state).toBe('outdated');
    expect(first()?.outdatedAt).toBe('2026-09-01T11:00:00.000Z');
    expect(reconcileOnSnapshot(temp.db, changeId, 'replaced', fingerprintsOf('A'), '2026-09-01T12:00:00.000Z')).toBe(0);
    expect(first()?.state).toBe('outdated');
    expect(first()?.outdatedAt).toBe('2026-09-01T11:00:00.000Z');
  });

  it('review/unchanged-put-keeps-marks: an unchanged put does nothing, even against other fingerprints', () => {
    const snapshot = snapshotInput(changeId, 'a'.repeat(40), { contentHash: 'h1', fingerprints: fingerprintsOf('A') });
    expect(temp.db.snapshots.put(snapshot)).toBe('created');
    mark(marked('A'));
    const again = temp.db.snapshots.put({ ...snapshot });
    expect(again).toBe('unchanged');
    expect(reconcileOnSnapshot(temp.db, changeId, again, fingerprintsOf('B'), '2026-09-01T11:00:00.000Z')).toBe(0);
    expect(first()?.state).toBe('current');
  });

  it('a new snapshot with the same fingerprints keeps the mark current', () => {
    mark(marked('A'));
    expect(reconcileOnSnapshot(temp.db, changeId, 'created', fingerprintsOf('A'), T)).toBe(0);
    expect(first()?.state).toBe('current');
  });

  it('a mark made again after it went outdated is current again', () => {
    mark(marked('A'));
    reconcileOnSnapshot(temp.db, changeId, 'replaced', fingerprintsOf('B'), '2026-09-01T11:00:00.000Z');
    mark(marked('B'));
    expect(first()?.state).toBe('current');
    expect(first()?.outdatedAt).toBeNull();
  });

  it('review/outdated-on-refreshed-put: a refreshed put (same Report, other bytes) outdates the changed file mark', () => {
    const snapshot = snapshotInput(changeId, 'a'.repeat(40), { contentHash: 'h1', fingerprints: fingerprintsOf('A') });
    expect(temp.db.snapshots.put(snapshot)).toBe('created');
    mark(marked('A'));
    const refreshed = temp.db.snapshots.put({ ...snapshot, fingerprints: fingerprintsOf('B') });
    expect(refreshed).toBe('refreshed');
    expect(reconcileOnSnapshot(temp.db, changeId, refreshed, fingerprintsOf('B'), '2026-09-01T11:00:00.000Z')).toBe(1);
    expect(first()?.state).toBe('outdated');
  });

  it('review/refreshed-put-keeps-other-symbol-marks: only the symbol whose slice changed is outdated', () => {
    const fps = (b: string): string => JSON.stringify({ files: {}, symbols: { s1: 'one', s2: b } });
    const snapshot = snapshotInput(changeId, 'a'.repeat(40), { contentHash: 'h1', fingerprints: fps('two') });
    temp.db.snapshots.put(snapshot);
    for (const [id, fingerprint] of [['s1', 'one'], ['s2', 'two']] as const) {
      temp.db.review.upsert({ changeId, target: { kind: 'symbol', id }, filePath: 'src/cart/total.ts', mark: 'good', note: null, lines: null, fingerprint, snapshotId: null, at: T });
    }
    const refreshed = temp.db.snapshots.put({ ...snapshot, fingerprints: fps('two-edited') });
    expect(refreshed).toBe('refreshed');
    reconcileOnSnapshot(temp.db, changeId, refreshed, fps('two-edited'), '2026-09-01T11:00:00.000Z');
    expect(temp.db.review.list(changeId).map((m) => [m.targetId, m.state])).toEqual([['s1', 'current'], ['s2', 'outdated']]);
  });

  it('review/null-incoming-fingerprints-keep-marks: a put without fingerprints leaves current marks current', () => {
    const snapshot = snapshotInput(changeId, 'a'.repeat(40), { contentHash: 'h1', fingerprints: fingerprintsOf('A') });
    temp.db.snapshots.put(snapshot);
    mark(marked('A'));
    const again = temp.db.snapshots.put({ ...snapshot, fingerprints: null });
    expect(again).toBe('unchanged');
    expect(reconcileOnSnapshot(temp.db, changeId, again, null, '2026-09-01T11:00:00.000Z')).toBe(0);
    expect(first()?.state).toBe('current');
  });
});

