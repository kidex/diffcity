// ui/format-labels (SPEC.md section 3a): Draft / Branch / PR #N and relative times.

import { describe, expect, it } from 'vitest';
import {
  aheadBehind,
  ARCHIVE_REASON_LABEL,
  ATTENTION_VERDICTS,
  changeName,
  EVENT_LABEL,
  kindLabel,
  lastAuditLabel,
  plural,
  QUIET_VERDICTS,
  refName,
  relativeTime,
  shortDate,
  shortSha,
  VERDICT_LABEL,
  VERDICTS,
} from '../../../src/ui/shared/format.js';

const NOW = Date.parse('2026-05-04T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('ui/format-labels', () => {
  describe('kind labels', () => {
    it('labels a draft as Draft', () => {
      expect(kindLabel({ kind: 'draft', prNumber: null })).toBe('Draft');
    });
    it('labels a branch as Branch', () => {
      expect(kindLabel({ kind: 'branch', prNumber: null })).toBe('Branch');
    });
    it('labels a pull request with its number', () => {
      expect(kindLabel({ kind: 'pr', prNumber: 7 })).toBe('PR #7');
    });
    it('labels a pull request without a number as PR', () => {
      expect(kindLabel({ kind: 'pr', prNumber: null })).toBe('PR');
    });
  });

  describe('change names', () => {
    it('names a branch by its branch name', () => {
      expect(changeName({ kind: 'branch', ref: 'branch:feature/order-discounts', title: 'Add order discounts' })).toBe(
        'feature/order-discounts',
      );
    });
    it('names a draft and a pull request by their title', () => {
      expect(changeName({ kind: 'draft', ref: 'draft:.', title: 'Uncommitted changes on main' })).toBe('Uncommitted changes on main');
      expect(changeName({ kind: 'pr', ref: 'pr:7', title: 'Refresh the session before expiry' })).toBe(
        'Refresh the session before expiry',
      );
    });
  });

  describe('relative time', () => {
    it.each<[number, string]>([
      [0, 'just now'],
      [59 * 1000, 'just now'],
      [MIN, '1 min ago'],
      [41 * MIN, '41 min ago'],
      [59 * MIN + 59_000, '59 min ago'],
      [HOUR, '1 h ago'],
      [23 * HOUR, '23 h ago'],
      [DAY, '1 day ago'],
      [3 * DAY + HOUR, '3 days ago'],
      [47 * DAY, '47 days ago'],
    ])('%i ms ago reads %j', (elapsed, label) => {
      expect(relativeTime(ago(elapsed), NOW)).toBe(label);
    });

    it('reads a time in the future as just now', () => {
      expect(relativeTime(ago(-5 * MIN), NOW)).toBe('just now');
    });

    it('returns an unparseable time unchanged', () => {
      expect(relativeTime('not a date', NOW)).toBe('not a date');
    });
  });

  it('shows a repo that was never audited as never audited', () => {
    expect(lastAuditLabel(null, NOW)).toBe('never audited');
    expect(lastAuditLabel({ at: ago(19 * DAY) }, NOW)).toBe('19 days ago');
  });

  it('counts with the right plural', () => {
    expect(plural(1, 'commit')).toBe('1 commit');
    expect(plural(4, 'commit')).toBe('4 commits');
    expect(plural(0, 'change')).toBe('0 changes');
  });

  it('shows ahead and behind, and nothing when the head is not available', () => {
    expect(aheadBehind({ ahead: 2, behind: 1 })).toBe('2 ahead, 1 behind');
    expect(aheadBehind({ ahead: null, behind: null })).toBe('');
  });

  it('labels the verdicts as SPEC.md section 5.2, in its order', () => {
    expect(VERDICTS.map((verdict) => VERDICT_LABEL[verdict])).toEqual([
      'Needs your eyes',
      'Risky',
      'Outside the spec',
      'Reviewed, fine',
      'Untouched',
    ]);
  });

  it('splits the verdicts into those asking for a look and the quiet ones, keeping the table order', () => {
    expect(ATTENTION_VERDICTS).toEqual(['eyes', 'risky', 'spec']);
    expect(QUIET_VERDICTS).toEqual(['ok', 'same']);
    expect([...ATTENTION_VERDICTS, ...QUIET_VERDICTS]).toEqual(VERDICTS);
  });

  it('names where a change lives from its ref', () => {
    expect(refName({ kind: 'branch', ref: 'branch:feature/order-discounts', prNumber: null })).toBe('feature/order-discounts');
    expect(refName({ kind: 'pr', ref: 'pr:7', prNumber: 7 })).toBe('#7');
    expect(refName({ kind: 'draft', ref: 'draft:.', prNumber: null })).toBe('main working tree');
    expect(refName({ kind: 'draft', ref: 'draft:../sample-shop-hotfix', prNumber: null })).toBe('../sample-shop-hotfix');
  });

  it('labels the last event and the archive reason', () => {
    expect(EVENT_LABEL.agent).toBe('Agent worked');
    expect(EVENT_LABEL.commit).toBe('Commit');
    expect(ARCHIVE_REASON_LABEL).toEqual({ merged: 'Merged', deleted: 'Branch deleted', closed: 'PR closed', clean: 'Draft cleaned' });
  });

  it('shows a date and a short sha', () => {
    expect(shortDate('2026-05-02T09:00:00.000Z', 'UTC')).toBe('2 May 2026');
    expect(shortDate('not a date')).toBe('not a date');
    expect(shortSha('3f2a9c41d0b7e6a5c4d3e2f1a0b9c8d7e6f5a4b3')).toBe('3f2a9c4');
  });
});
