// send-review/* (ADR-029, DC-134): the pure side of "Send review to agent":
// the daemon's preview mapped to what the dialog shows (argv per line, the
// session or why a new one, the permission note, refusals), the Send gate
// (sendable and the summary read), and the run status line.

import { describe, expect, it } from 'vitest';
import type { AgentRunsResponse, AgentRunView } from '../../../src/core/model/types.js';
import {
  NEW_SESSION_REASON,
  notesCount,
  PERMISSION_DEFAULT,
  permissionNote,
  queuedText,
  runStatusView,
  sendDialogView,
  sendEnabled,
  sessionRange,
} from '../../../src/ui/screens/change/model/agent.js';
import type { AgentPreview } from '../../../src/ui/screens/change/ports.js';

const SESSION = '0f8d2c4e-5b1a-4c3d-9e7f-1a2b3c4d5e6f';

const preview = (over: Partial<AgentPreview> = {}): AgentPreview => ({
  mode: 'resume',
  argv: ['/opt/tools/claude', '--resume', SESSION, '-p', '--output-format', 'json'],
  cwd: '/work/order-desk',
  sessionId: SESSION,
  session: { sessionId: SESSION, title: 'Add order discounts', firstAt: '2026-05-02T10:14:00.000Z', lastAt: '2026-05-02T11:02:00.000Z' },
  newSessionReason: null,
  permissionMode: null,
  timeoutMinutes: 30,
  summary: '# Review of feat/discounts\n\n## Needs rewrite (1)\n',
  summaryHash: 'a'.repeat(64),
  refusals: [],
  token: 'tok-1',
  ...over,
});

const run = (over: Partial<AgentRunView> = {}): AgentRunView => ({
  runId: '0123456789abcdef',
  state: 'done',
  mode: 'resume',
  startedAt: '2026-05-02T11:10:00.000Z',
  durationMs: 4200,
  exitCode: 0,
  log: '11-0123456789abcdef.log',
  message: null,
  ...over,
});

describe('send-review/dialog-model', () => {
  it('shows the argv one item per line, the working tree and the resumed session with its time range', () => {
    const view = sendDialogView(preview(), 'UTC');
    expect(view.argv).toEqual(['/opt/tools/claude', '--resume', SESSION, '-p', '--output-format', 'json']);
    expect(view.cwd).toBe('/work/order-desk');
    expect(view.session).toEqual({ kind: 'resume', title: 'Add order discounts', range: '2 May 2026, 10:14–11:02' });
    expect(view.permission).toBe(PERMISSION_DEFAULT);
    expect(view.timeout).toBe('Stopped after 30 minutes');
    expect(view.sendable).toBe(true);
  });

  it('names why a new session is started, and an untitled session', () => {
    const fresh = sendDialogView(preview({ mode: 'new', session: null, sessionId: null, newSessionReason: 'transcript-gone' }));
    expect(fresh.session).toEqual({ kind: 'new', reason: NEW_SESSION_REASON['transcript-gone'] });
    const untitled = sendDialogView(preview({ session: { sessionId: SESSION, title: null, firstAt: null, lastAt: null } }));
    expect(untitled.session).toEqual({ kind: 'resume', title: 'Untitled session', range: null });
  });

  it('says the permission mode settings.json names', () => {
    expect(permissionNote(null)).toBe('The agent runs with your Claude Code permission settings for this project');
    expect(permissionNote('acceptEdits')).toBe('Permission mode: acceptEdits');
    expect(sendDialogView(preview({ permissionMode: 'plan' })).permission).toBe('Permission mode: plan');
  });

  it('is not sendable with any refusal, without a token or without an argv', () => {
    const refused = sendDialogView(
      preview({ token: null, argv: null, cwd: null, mode: null, session: null, refusals: [{ code: 'agent-launch-disabled', message: 'agent launch is off' }] }),
    );
    expect(refused.sendable).toBe(false);
    expect(refused.argv).toEqual([]);
    expect(refused.refusals).toEqual([{ code: 'agent-launch-disabled', message: 'agent launch is off' }]);
    expect(sendDialogView(preview({ token: null })).sendable).toBe(false);
    expect(sendDialogView(preview({ refusals: [{ code: 'run-in-progress', message: 'busy' }] })).sendable).toBe(false);
  });

  it('enables Send only once the summary was read, and not while a request is in flight', () => {
    const view = sendDialogView(preview());
    expect(sendEnabled(view, false, false)).toBe(false);
    expect(sendEnabled(view, true, false)).toBe(true);
    expect(sendEnabled(view, true, true)).toBe(false);
    expect(sendEnabled(sendDialogView(preview({ token: null })), true, false)).toBe(false);
  });

  it('writes a session range across two days and with one end only', () => {
    expect(sessionRange('2026-05-02T23:50:00.000Z', '2026-05-03T00:20:00.000Z', 'UTC')).toBe('2 May 2026, 23:50 – 3 May 2026, 00:20');
    expect(sessionRange(null, '2026-05-03T00:20:00.000Z', 'UTC')).toBe('3 May 2026, 00:20');
    expect(sessionRange('not a date', null)).toBeNull();
  });

  it('says what the fix queue answered', () => {
    expect(queuedText({ queued: true, count: 1 })).toBe('Added to the fix queue (1 item waiting for /diffcity-review)');
    expect(queuedText({ queued: false, count: 3 })).toBe('Already in the fix queue (3 items waiting for /diffcity-review)');
  });
});

describe('send-review/run-status-model', () => {
  const runs = (latest: AgentRunView | null, running = false): AgentRunsResponse => ({ running, latest });

  it('is hidden while the change never had a run', () => {
    expect(runStatusView(null, 2)).toEqual({ kind: 'hidden' });
    expect(runStatusView(runs(null), 2)).toEqual({ kind: 'hidden' });
  });

  it('counts the notes while running', () => {
    const latest = run({ state: 'running', exitCode: null, durationMs: null });
    expect(runStatusView(runs(latest, true), 3)).toMatchObject({ kind: 'running', text: 'Agent is working on 3 notes', log: '11-0123456789abcdef.log' });
    expect(runStatusView(runs(latest, true), 1)).toMatchObject({ text: 'Agent is working on 1 note' });
    expect(runStatusView(runs(latest, true), null)).toMatchObject({ text: 'Agent is working on the review' });
  });

  it('gives the end state, the exit code and the log name', () => {
    expect(runStatusView(runs(run()), 2)).toEqual({ kind: 'ended', state: 'done', text: 'Agent finished', exit: 'exit 0', log: '11-0123456789abcdef.log', title: null });
    expect(runStatusView(runs(run({ state: 'failed', exitCode: 2, message: 'claude reported an error' })), 2)).toMatchObject({
      text: 'Agent run failed',
      exit: 'exit 2',
      title: 'claude reported an error',
    });
    expect(runStatusView(runs(run({ state: 'timeout', exitCode: null })), 2)).toMatchObject({ text: 'Agent run timed out', exit: 'no exit code' });
  });

  it('counts the current "Needs rewrite" marks and the general note', () => {
    expect(notesCount(null)).toBeNull();
    expect(notesCount({ progress: { rewrite: 2 }, note: null })).toBe(2);
    expect(notesCount({ progress: { rewrite: 2 }, note: 'Ship after this.' })).toBe(3);
    expect(notesCount({ progress: { rewrite: 0 }, note: '   ' })).toBe(0);
  });
});
