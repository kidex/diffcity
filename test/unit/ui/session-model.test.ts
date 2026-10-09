// session-model/cards-order-and-status (ADR-038): what the Session tab shows,
// as data from the daemon's SessionsResponse and the Report. The cards keep
// the daemon's order (newest first); an unreadable session has no content, a
// stale one keeps its data with an "out of date" note, an unread one says so;
// the runs nest under the parent the daemon shows, by order; durations carry
// "≈" when approximate; edited files point at a building only when the Report
// has the path; "20 of N sessions" only when the daemon holds more.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionRunView, SessionsResponse, SessionView } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import {
  durationText,
  hasSessions,
  rangeText,
  runRows,
  sessionTab,
  STALE_SESSION,
  UNTITLED_SESSION,
} from '../../../src/ui/screens/change/model/session.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/ui/${name}`, import.meta.url), 'utf8'));
const two = (): SessionsResponse => fixture('sessions-two.json') as SessionsResponse;
const parseError = (): SessionsResponse => fixture('sessions-parse-error.json') as SessionsResponse;

function report(paths: string[]): Report {
  return {
    meta: {} as Report['meta'],
    packages: [
      {
        id: 'src',
        path: 'src',
        tier1: false,
        files: paths.map((path) => ({ id: `id:${path}`, path, language: 'typescript', status: 'mod', verdict: 'ok', inSpec: null, symbols: [] })),
      },
    ],
    steps: [],
    findings: [],
    summary: {} as Report['summary'],
  } as unknown as Report;
}

const GUARD = 'src/auth/order.guard.ts';
const SERVICE = 'src/services/orders/orders.service.ts';

function run(agentId: string, order: number, parentAgentId: string | null = null): SessionRunView {
  const base = two().sessions[0]?.digest?.runs[0];
  if (base === undefined) throw new Error('fixture run missing');
  return { ...base, agentId, toolUseId: `t-${agentId}`, order, parentAgentId };
}

describe('session-model/cards-order-and-status', () => {
  it('keeps the daemon order, newest first, and falls back to "Untitled session"', () => {
    const tab = sessionTab(two(), report([GUARD]), 'UTC');
    expect(tab.cards.map((card) => card.key)).toEqual(two().sessions.map((session) => session.sessionId));
    expect(tab.cards[0]?.title).toBe('Add percentage discounts to orders');
    expect(tab.cards[1]?.title).toBe(UNTITLED_SESSION);
    expect(tab.cards[1]?.untitled).toBe(true);
    expect(tab.cards[0]?.range).toBe('8 Oct 2026, 09:12 – 10:47');
    expect(tab.shown).toBeNull();
  });

  it('says "20 of N sessions" only when the daemon links more than it served', () => {
    const base = two();
    const first = base.sessions[0] as SessionView;
    const twenty = Array.from({ length: 20 }, (_, index) => ({ ...first, sessionId: `s-${String(index)}` }));
    expect(sessionTab({ sessions: twenty, total: 34 }, report([]), 'UTC').shown).toBe('20 of 34 sessions');
    expect(sessionTab({ sessions: twenty, total: 20 }, report([]), 'UTC').shown).toBeNull();
  });

  it('shows the tab only with sessions', () => {
    expect(hasSessions(null)).toBe(false);
    expect(hasSessions({ sessions: [], total: 0 })).toBe(false);
    expect(hasSessions(two())).toBe(true);
  });

  it('gives an unreadable session no content, a stale one its data and a note, an unread one its own state', () => {
    const [unreadable] = sessionTab(parseError(), report([]), 'UTC').cards;
    expect(unreadable?.state).toBe('unreadable');
    expect(unreadable?.prompts).toEqual([]);
    expect(unreadable?.runs).toEqual([]);
    expect(unreadable?.wide).toBeNull();

    // Unreadable wins even if a digest came along.
    const leaked = parseError();
    const session = leaked.sessions[0] as SessionView;
    session.digest = two().sessions[0]?.digest ?? null;
    expect(sessionTab(leaked, report([]), 'UTC').cards[0]?.prompts).toEqual([]);

    const stale = sessionTab(two(), report([]), 'UTC').cards[1];
    expect(stale?.state).toBe('stale');
    expect(stale?.notes).toContain(STALE_SESSION);
    expect(stale?.prompts.map((prompt) => prompt.text)).toEqual(['Write the migration for the discount column.']);

    const fresh = sessionTab(two(), report([]), 'UTC').cards[0];
    expect(fresh?.state).toBe('ok');
    expect(fresh?.notes).toEqual([]);

    const unread = two();
    (unread.sessions[0] as SessionView).digest = null;
    expect(sessionTab(unread, report([]), 'UTC').cards[0]?.state).toBe('unread');
  });

  it('nests runs under the parent the daemon shows, by order, and lists an orphan or a cycle at the top', () => {
    const rows = runRows([run('c', 3, 'a'), run('b', 2), run('a', 1), run('d', 4, 'c'), run('e', 5, 'missing')], new Map());
    expect(rows.map((row) => [row.key, row.depth])).toEqual([
      ['a', 0],
      ['c', 1],
      ['d', 2],
      ['b', 0],
      ['e', 0],
    ]);
    const cycle = runRows([run('x', 1, 'y'), run('y', 2, 'x')], new Map());
    expect(cycle.map((row) => row.key).sort()).toEqual(['x', 'y']);
  });

  it('reads the fixture runs: type, description, "≈" duration, status and its source, here', () => {
    const card = sessionTab(two(), report([SERVICE]), 'UTC').cards[0];
    const rows = card?.runs ?? [];
    expect(rows.map((row) => [row.type, row.depth, row.duration, row.status, row.run.here])).toEqual([
      ['Plan', 0, '1 min 35 s', 'completed', true],
      ['general-purpose', 0, '≈ 5 min 12 s', 'completed', true],
      ['Explore', 1, null, 'running', false],
    ]);
    expect(rows[1]?.statusSource).toBe('Status from the task notification');
    expect(rows[2]?.statusSource).toBe('No status reported yet');
    expect(card?.elsewhere).toBe('2 runs in other working trees');
  });

  it('formats durations', () => {
    expect(durationText(null, false)).toBeNull();
    expect(durationText(42_000, false)).toBe('42 s');
    expect(durationText(180_000, true)).toBe('≈ 3 min');
    expect(durationText(3_840_000, false)).toBe('1 h 4 min');
  });

  it('formats the time range', () => {
    expect(rangeText(null, null, 'UTC')).toBe('');
    expect(rangeText('2026-10-08T09:12:00Z', null, 'UTC')).toBe('8 Oct 2026, 09:12');
    expect(rangeText('2026-10-08T23:50:00Z', '2026-10-09T00:20:00Z', 'UTC')).toBe('8 Oct 2026, 23:50 – 9 Oct 2026, 00:20');
  });

  it('points edited files at their building only when the Report has the path, and builds the chips', () => {
    const card = sessionTab(two(), report([GUARD, SERVICE]), 'UTC').cards[0];
    expect(card?.wide?.files).toEqual([
      { path: GUARD, fileId: `id:${GUARD}` },
      { path: SERVICE, fileId: `id:${SERVICE}` },
      { path: 'src/services/orders/discount.rules.ts', fileId: null },
      { path: 'docs/discounts.md', fileId: null },
    ]);
    expect(card?.wide?.outside).toBe('1 file outside the repo');
    expect(card?.wide?.chips).toEqual([]);
    expect(card?.main?.chips.map((chip) => `${chip.label} ${String(chip.count)}`)).toEqual(['Edits 1', 'Reads and searches 3', 'Shell 1', 'Subagents 3']);
    expect(card?.runs[1]?.activity.chips.map((chip) => `${chip.label} ${String(chip.count)}`)).toEqual(['Edits 3', 'Shell 2', 'MCP tracker 1']);
  });
});
