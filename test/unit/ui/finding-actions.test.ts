// panel/finding-actions (DC-108, ADR-036): a written state keeps the card
// inert until the Report shows it, and no longer than until a Report whose
// fetch began after the write was answered, whatever that Report says: a
// stale state never leaves a card inert for the rest of the session. A failed
// refetch (no Report at all) ends at the next successful load.

import { describe, expect, it } from 'vitest';
import type { Finding, Report } from '../../../src/core/report/types.js';
import type { FindingsPort } from '../../../src/ui/screens/change/ports.js';
// createFindingActions needs `document` only to draw buttons (fill), which these tests never call.
import { createFindingActions } from '../../../src/ui/screens/change/panel/finding-actions.js';

const KEY = 'f:0a0b0c0d0e0f1011';

const finding = (state: Finding['state']): Finding => ({
  id: KEY,
  source: 'claude',
  severity: 'high',
  category: 'correctness',
  file: 'src/till/price.ts',
  line: 3,
  title: 'Price rounds down',
  message: 'Rounds down.',
  state,
});

const report = (findings: Finding[]): Report => ({ findings }) as unknown as Report;

/** A port whose writes are all accepted, answered at `at`. */
function port(at: number): FindingsPort {
  return {
    ask: (key) => Promise.resolve({ ok: true, value: { key, queued: true, count: 1 }, at }),
    setState: (key, state) => Promise.resolve({ ok: true, value: { key, state, keys: [key] }, at }),
  };
}

const labels = (actions: ReturnType<typeof createFindingActions>, state: Finding['state']): string[] =>
  actions.view(finding(state)).buttons.map((button) => `${button.label}${button.disabled ? ' (inert)' : ''}`);

describe('finding-actions', () => {
  it('stale-state-ends-with-a-report-fetched-after-the-answer', async () => {
    const actions = createFindingActions(port(100));
    await actions.act('intend', finding('open'));
    // Answered; the Report on screen still says open: the card offers Undo, inert.
    expect(labels(actions, 'open')).toEqual(['Undo (inert)']);
    // A Report whose fetch began before the answer, still open: stays inert.
    actions.sync(report([finding('open')]), 99);
    expect(labels(actions, 'open')).toEqual(['Undo (inert)']);
    // A refetch failed: no Report arrives, nothing changes.
    expect(labels(actions, 'open')).toEqual(['Undo (inert)']);
    // The next successful load began after the answer: its word stands, even if it still says open.
    actions.sync(report([finding('open')]), 100);
    expect(labels(actions, 'open')).toEqual(['Ask agent to fix', 'Mark as intended']);
    actions.dispose();
  });

  it('settles-when-the-report-shows-the-state-or-drops-the-finding', async () => {
    const shown = createFindingActions(port(100));
    await shown.act('intend', finding('open'));
    // Fetch time unknown (null): the Report that shows the state settles it.
    shown.sync(report([finding('intended')]), null);
    expect(labels(shown, 'intended')).toEqual(['Undo']);
    shown.sync(report([finding('open')]), null);
    expect(labels(shown, 'open')).toEqual(['Ask agent to fix', 'Mark as intended']);

    const dropped = createFindingActions(port(100));
    await dropped.act('intend', finding('open'));
    dropped.sync(report([]), null);
    expect(labels(dropped, 'open')).toEqual(['Ask agent to fix', 'Mark as intended']);
  });
});
