// The served view of a linked session (ADR-038): parse state stripped, runs
// filtered to the change's working tree and marked `here`.

import { describe, expect, it } from 'vitest';
import { sessionView, treeContaining, type SessionRow } from '../../../src/core/session/index.js';
import { digestOf, transcript } from '../../helpers/transcript.js';

const MAIN = '/work/shopfront';
const RACK = '/work/shopfront/.worktrees/rack';

function row(digest: string | null, overrides: Partial<SessionRow> = {}): SessionRow {
  return { sessionId: 'abcdef01', title: 'T', firstAt: null, lastAt: null, cwd: MAIN, digest, parseError: null, firstHead: 'h', lastHead: 'h', linkedAt: '2026-09-01T09:00:00.000Z', ...overrides };
}

function sample(): string {
  const main = transcript().prompt('Split');
  main.agent({ agentId: 'a1', foreground: { report: 'r1', durationMs: 1, toolUses: 1 } });
  main.agent({ agentId: 'a2', foreground: { report: 'r2', durationMs: 1, toolUses: 1 } });
  main.agent({ agentId: 'a3', foreground: { report: 'r3', durationMs: 1, toolUses: 1 } });
  const digest = digestOf({
    main,
    sidechains: { a1: transcript({ agentId: 'a1', cwd: `${MAIN}/src` }).text('r1'), a2: transcript({ agentId: 'a2', cwd: RACK }).text('r2'), a3: transcript({ agentId: 'a3', cwd: '/tmp/scratch' }).text('r3') },
  });
  return JSON.stringify(digest);
}

describe('session view', () => {
  it('treeContaining picks the innermost tree, never a sibling with a common prefix', () => {
    expect(treeContaining([MAIN, RACK], `${RACK}/src`)).toBe(RACK);
    expect(treeContaining([MAIN, RACK], `${MAIN}/src`)).toBe(MAIN);
    expect(treeContaining([MAIN], '/work/shopfront-old/src')).toBeNull();
    expect(treeContaining([MAIN], MAIN)).toBe(MAIN);
  });

  it('runs here are marked, runs in another tree are counted out, runs in no known tree are kept', () => {
    const view = sessionView(row(sample()), { changeTree: MAIN, trees: [MAIN, RACK] });
    expect(view.here).toBe(true);
    expect(view.digest?.runs.map((run) => [run.agentId, run.here])).toEqual([
      ['a1', true],
      ['a3', false],
    ]);
    expect(view.digest?.runsElsewhere).toBe(1);
    expect(view.digest).not.toHaveProperty('state');
  });

  it('a change checked out nowhere keeps every run, none here', () => {
    const view = sessionView(row(sample()), { changeTree: null, trees: [MAIN, RACK] });
    expect(view.here).toBe(false);
    expect(view.digest?.runs.map((run) => run.here)).toEqual([false, false, false]);
    expect(view.digest?.runsElsewhere).toBe(0);
  });

  it('a parse error or a digest that is not one is unreadable, with no content', () => {
    expect(sessionView(row(sample(), { parseError: 'read-failed' }), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: true, digest: null });
    expect(sessionView(row('{"format":99}'), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: true, digest: null });
    expect(sessionView(row(null), { changeTree: MAIN, trees: [MAIN] })).toMatchObject({ unreadable: false, digest: null });
  });
});
