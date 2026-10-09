// The AgentPort (ADR-029): "Send review to agent" on one change, without the
// screen knowing about the daemon. The SPA builds it from the API client and
// the SSE connection; the change screen takes it as optional and the HTML
// export passes none (ADR-002). Nothing is decided here: the command, the
// session, every refusal and the run's state are the daemon's.

import type { AgentRunsResponse } from '../../core/model/types.js';
import type { AgentPreview, Api, SummaryQueueAnswer } from './api.js';
import { ApiRequestError } from './api.js';
import type { FindingAnswer } from './findings-port.js';
import { answer } from './findings-port.js';
import type { Coalescer, Live, Unsubscribe } from './live.js';

export interface AgentPort {
  preview(): Promise<FindingAnswer<AgentPreview>>;
  run(token: string, summaryHash: string): Promise<FindingAnswer<{ runId: string }>>;
  queue(summaryHash: string): Promise<FindingAnswer<SummaryQueueAnswer>>;
  /** The run in progress or the latest one; null when the daemon refuses to say (403, 404). Rejects on anything else. */
  runs(signal?: AbortSignal): Promise<AgentRunsResponse | null>;
  /** SSE `agent-run` of this change, and `hello` after a reconnect. */
  onRun(listener: () => void): Unsubscribe;
}

/** The port of one change; with `refetch`, a burst of events reloads at most once per 250 ms. */
export function createAgentPort(api: Api, live: Live, changeId: number, refetch?: Coalescer): AgentPort {
  const key = `agent-runs:${String(changeId)}`;
  return {
    preview: () => answer(api.agentPreview(changeId)),
    run: (token, summaryHash) => answer(api.agentRun(changeId, token, summaryHash)),
    queue: (summaryHash) => answer(api.queueSummary(changeId, summaryHash)),
    async runs(signal) {
      try {
        return await api.agentRuns(changeId, signal);
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
    },
    onRun(listener) {
      const fire = (): void => {
        if (refetch === undefined) listener();
        else refetch.request(key, listener);
      };
      const stops = [
        live.on('hello', fire),
        live.on('agent-run', (data) => {
          if (data.changeId === changeId) fire();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
