import { describe, expect, it } from 'vitest';
import { applyAgent, worktreeContaining } from '../../../src/core/changes/agent.js';
import { ARCHIVE_RETENTION_DAYS, archiveCutoff, isArchiveViewable } from '../../../src/core/changes/archive.js';
import { REPO, record, sha, worktree } from './builders.js';

const AT = '2026-03-10T12:00:00.000Z';
const A = sha('a1');

describe('applyAgent (C3, ADR-001)', () => {
  it('changes/agent-marks-current-change (C3): the change of the working tree becomes agent-unreviewed with an agent event', () => {
    const change = record({ id: 4, head: A, worktreePath: REPO, reviewState: 'approved', lastEventType: 'commit' });
    const other = record({ id: 5, head: sha('b1') });
    const outcome = applyAgent([other, change], worktree({ head: A }), AT);
    expect(outcome.update).toMatchObject({
      id: 4,
      fields: { reviewState: 'unreviewed', lastEventType: 'agent', lastEventAt: AT, updatedAt: AT, head: A },
    });
    expect(outcome.event).toEqual({ changeId: 4, type: 'agent', at: AT, payload: { worktree: REPO } });
  });

  it('finds the change by the working tree HEAD when no change records the working tree', () => {
    const change = record({ id: 4, kind: 'pr', ref: 'pr:3', prNumber: 3, head: A, worktreePath: null });
    expect(applyAgent([change], worktree({ head: A }), AT).event.changeId).toBe(4);
  });

  it("does not take another working tree's Draft at the same HEAD", () => {
    const otherDraft = record({ id: 6, kind: 'draft', ref: 'draft:../agent', head: A, worktreePath: '/work/agent', dirty: true });
    const outcome = applyAgent([otherDraft], worktree({ head: A }), AT);
    expect(outcome.update).toBeNull();
    expect(outcome.event.changeId).toBeNull();
  });

  it('changes/agent-on-clean-base (C3): with no change for the working tree only a repo-level agent event is written', () => {
    const outcome = applyAgent([record({ id: 5, head: sha('b1') })], worktree(), AT);
    expect(outcome).toEqual({ update: null, event: { changeId: null, type: 'agent', at: AT, payload: { worktree: REPO } } });
  });

  it('worktreeContaining picks the innermost working tree that contains the directory', () => {
    const main = worktree();
    const linked = worktree({ path: `${REPO}/.worktrees/agent` });
    expect(worktreeContaining([main, linked], `${REPO}/.worktrees/agent/src`)).toBe(linked);
    expect(worktreeContaining([main, linked], `${REPO}/src`)).toBe(main);
    expect(worktreeContaining([main, linked], REPO)).toBe(main);
    expect(worktreeContaining([main, linked], `${REPO}-other`)).toBeNull();
  });
});

describe('archive retention (L7, Q4)', () => {
  const archivedAt = '2026-01-01T00:00:00.000Z';
  const archived = record({ archivedAt, archiveReason: 'merged' });
  const day = (n: number): Date => new Date(Date.parse(archivedAt) + n * 86_400_000);

  it('keeps archived changes for 90 days', () => {
    expect(ARCHIVE_RETENTION_DAYS).toBe(90);
  });

  it('changes/archived-viewable-90-days (L7): an archived change is viewable until day 90 included', () => {
    expect(isArchiveViewable(archived, day(0))).toBe(true);
    expect(isArchiveViewable(archived, day(89))).toBe(true);
    expect(isArchiveViewable(archived, day(90))).toBe(true);
  });

  it('changes/purge-after-90-days (L7): it is gone after day 90', () => {
    expect(isArchiveViewable(archived, new Date(day(90).getTime() + 1))).toBe(false);
    expect(isArchiveViewable(archived, day(91))).toBe(false);
    // purgeArchived deletes `archivedAt < cutoff`.
    expect(archiveCutoff(day(91)) > archivedAt).toBe(true);
    expect(archiveCutoff(day(90)) > archivedAt).toBe(false);
  });

  it('a live change is not an archived one', () => {
    expect(isArchiveViewable(record(), day(1))).toBe(false);
  });
});
