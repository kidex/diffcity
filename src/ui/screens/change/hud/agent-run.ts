// The agent run status in the top bar (ADR-029), with an AgentPort only: the
// HTML export and the standalone page have none. It reads the run in progress
// or the latest one from the daemon when the screen mounts (so it survives a
// reload), again on every SSE `agent-run` of the change and after a
// reconnect: "Agent is working on N notes" while it runs; at the end the state,
// the exit code and the run log's file name. Hidden while the change never had
// a run. Text goes in through textContent only.

import type { AgentRunsResponse } from '../../../../core/model/types.js';
import { h, replaceChildren } from '../../../shared/dom.js';
import type { RunStatusView } from '../model/agent.js';
import { runStatusView } from '../model/agent.js';
import type { AgentPort } from '../ports.js';

export const LOG_TITLE = 'The run log, in the runs folder of your diffcity home';

export interface AgentRunStatus {
  root: HTMLElement;
  /** Reads the runs again (after a send, before its SSE signal arrives). */
  refresh(): void;
  /** The notes count may have moved: draws again. */
  render(): void;
  view(): RunStatusView;
  dispose(): void;
}

/** `notes()`: the notes the agent works on, or null while the review state is not known. */
export function createAgentRunStatus(port: AgentPort, notes: () => number | null): AgentRunStatus {
  const root = h('div', { class: 'agent-run', role: 'status', 'aria-live': 'polite', 'data-testid': 'agent-run' });
  root.hidden = true;
  let runs: AgentRunsResponse | null = null;
  let loading: AbortController | null = null;
  let disposed = false;

  const view = (): RunStatusView => runStatusView(runs, notes());

  function render(): void {
    if (disposed) return;
    const shown = view();
    root.hidden = shown.kind === 'hidden';
    root.dataset['state'] = shown.kind === 'ended' ? shown.state : shown.kind;
    if (shown.kind === 'hidden') {
      replaceChildren(root);
      return;
    }
    const log = shown.log === null ? null : h('code', { class: 'agent-run-log', title: LOG_TITLE, 'data-testid': 'agent-run-log' }, shown.log);
    if (shown.kind === 'running') {
      replaceChildren(root, h('i', { class: 'agent-run-dot', 'aria-hidden': 'true' }), h('span', { 'data-testid': 'agent-run-text' }, shown.text), log);
      return;
    }
    replaceChildren(
      root,
      h('i', { class: 'agent-run-dot', 'aria-hidden': 'true' }),
      h('span', { 'data-testid': 'agent-run-text', title: shown.title }, shown.text),
      h('span', { class: 'agent-run-exit', 'data-testid': 'agent-run-exit' }, shown.exit),
      log,
    );
  }

  function refresh(): void {
    if (disposed) return;
    loading?.abort();
    const request = new AbortController();
    loading = request;
    port.runs(request.signal).then(
      (answer) => {
        if (request.signal.aborted || disposed) return;
        runs = answer;
        render();
      },
      () => {
        // Keep what is shown: the daemon indicator says why it is stale; the next event or reconnect reads again.
      },
    );
  }

  const stop = port.onRun(refresh);
  refresh();

  return {
    root,
    refresh,
    render,
    view,
    dispose() {
      disposed = true;
      loading?.abort();
      stop();
      root.remove();
    },
  };
}
