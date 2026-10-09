// The routes of "send review to the agent" (ADR-029). Both are POST, so the
// server's write guard runs first (own Origin, no cross-site Fetch metadata,
// JSON; ADR-028); each also checks the request's origin itself.
//
//   POST /api/changes/:id/agent/preview
//     -> 200 { mode, argv, cwd, sessionId, session, newSessionReason,
//              permissionMode, timeoutMinutes, summary, summaryHash, refusals, token }
//        `token` is null while anything is refused.
//   POST /api/changes/:id/agent/run { token, summaryHash }
//     -> 202 { runId }, or 409 with the refusal code
//   GET  /api/changes/:id/agent/runs
//     -> 200 { running, latest }: the run in progress or the latest recorded one,
//        for a dialog opened after a reload; cross-site 403, no-store.
//   POST /api/changes/:id/review/summary/queue { summaryHash }
//     -> 200 { key, queued, count }: the summary as one fix-queue item; nothing runs.
//
// The run recomputes the whole plan: every refusal is checked again, and the
// argv, the cwd and the summary must be the ones the token was issued for.

import type { FastifyInstance } from 'fastify';
import type { AgentRefusal, AgentRefusalCode } from '../../core/agent/index.js';
import type { Db } from '../../core/db/index.js';
import { appendToFixQueue, fixQueueRoot, type SummaryQueueItem } from '../../core/fix-queue/index.js';
import type { AgentRunState, AgentRunView, AgentRunsResponse, ChangeRecord, EventRecord } from '../../core/model/types.js';
import { createConfirmedActions, type ConfirmOptions } from '../actions/confirm.js';
import { isSameOrigin } from '../api/origin.js';
import { parseId } from '../api/params.js';
import { HttpError } from '../http/errors.js';
import { planAgentRun, summaryOf, type AgentPlan, type PlanDeps } from './plan.js';
import type { AgentRuns } from './runs.js';
import { summaryHash as hashOf } from '../../core/agent/index.js';

export interface AgentRoutesDeps extends Omit<PlanDeps, 'busy'> {
  runs: AgentRuns;
  port: () => number;
  now: () => Date;
  /** The token clock and lifetime; two minutes on the system clock by default. */
  tokens?: ConfirmOptions;
}

/** What a token stands for. */
interface Binding {
  changeId: number;
  argv: readonly string[];
  cwd: string;
  summaryHash: string;
}

export interface PreviewAnswer {
  mode: AgentPlan['mode'];
  argv: string[] | null;
  cwd: string | null;
  sessionId: string | null;
  session: AgentPlan['session'];
  newSessionReason: AgentPlan['newSessionReason'];
  permissionMode: AgentPlan['permissionMode'];
  timeoutMinutes: number;
  summary: string;
  summaryHash: string;
  refusals: AgentRefusal[];
  token: string | null;
}

interface IdParams {
  id: string;
}

const HASH = /^[0-9a-f]{64}$/;

const refused = (code: AgentRefusalCode, message: string): HttpError => new HttpError(409, code, message);

const STATES: readonly AgentRunState[] = ['running', 'done', 'failed', 'timeout', 'stopped'];

/** The view of a recorded agent-run event; null when its payload is not one diffcity wrote. */
function viewOf(event: EventRecord): AgentRunView | null {
  const p = event.payload;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
  const f = p as Record<string, unknown>;
  const state = f['state'];
  const mode = f['mode'];
  const runId = f['runId'];
  if (typeof runId !== 'string' || !STATES.includes(state as AgentRunState) || (mode !== 'resume' && mode !== 'new')) return null;
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    runId,
    state: state as AgentRunState,
    mode,
    startedAt: str(f['startedAt']) ?? event.at,
    durationMs: num(f['durationMs']),
    exitCode: num(f['exitCode']),
    log: str(f['log']),
    message: str(f['message']),
  };
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

function bodyField(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
}

function parseHash(body: unknown): string {
  const hash = bodyField(body, 'summaryHash');
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new HttpError(400, 'bad-request', 'summaryHash must be the 64-hex sha256 of the summary');
  return hash;
}

export function registerAgentRoutes(http: FastifyInstance, deps: AgentRoutesDeps): void {
  const db: Db = deps.db;
  const tokens = createConfirmedActions<Binding>(deps.tokens);
  const planDeps: PlanDeps = { db, settingsPath: deps.settingsPath, env: deps.env, projectsDir: deps.projectsDir, busy: (id) => deps.runs.busy(id) };

  const changeOf = (rawId: string): ChangeRecord => {
    const id = parseId('id', rawId);
    const change = db.changes.get(id);
    if (change === null) throw new HttpError(404, 'not-found', `change ${String(id)} not found`);
    return change;
  };

  const ownPage = (request: Parameters<typeof isSameOrigin>[0]): void => {
    if (!isSameOrigin(request, deps.port())) throw new HttpError(403, 'cross-site', 'agent launch is for the daemon page only');
  };

  http.post<{ Params: IdParams }>('/api/changes/:id/agent/preview', async (request): Promise<PreviewAnswer> => {
    ownPage(request);
    const change = changeOf(request.params.id);
    const plan = await planAgentRun(planDeps, change);
    const ready = plan.refusals.length === 0 && plan.argv !== null && plan.cwd !== null;
    const token =
      ready && plan.argv !== null && plan.cwd !== null
        ? tokens.issue({ changeId: change.id, argv: plan.argv, cwd: plan.cwd, summaryHash: plan.summaryHash })
        : null;
    return {
      mode: plan.mode,
      argv: plan.argv,
      cwd: plan.cwd,
      sessionId: plan.session?.sessionId ?? null,
      session: plan.session,
      newSessionReason: plan.newSessionReason,
      permissionMode: plan.permissionMode,
      timeoutMinutes: plan.timeoutMinutes,
      summary: plan.summary,
      summaryHash: plan.summaryHash,
      refusals: plan.refusals,
      token,
    };
  });

  http.post<{ Params: IdParams; Body: unknown }>('/api/changes/:id/agent/run', async (request, reply) => {
    ownPage(request);
    const change = changeOf(request.params.id);
    const hash = parseHash(request.body);
    // Consumed here, whatever follows: a refused run needs a new preview.
    const binding = tokens.take(bodyField(request.body, 'token'));
    if (binding?.changeId !== change.id) throw refused('token-invalid', 'the confirmation is unknown, used or expired; preview again');
    if (hash !== binding.summaryHash) throw refused('summary-changed', 'the summary is not the one previewed; preview again');

    const plan = await planAgentRun(planDeps, change);
    if (plan.summaryHash !== binding.summaryHash) throw refused('summary-changed', 'the review changed since the preview; preview again');
    const first = plan.refusals[0];
    if (first !== undefined) throw refused(first.code, first.message);
    if (plan.argv === null || plan.args === null || plan.binary === null || plan.cwd === null || plan.mode === null) {
      throw refused('token-invalid', 'nothing can run for this change; preview again');
    }
    if (!sameArgv(plan.argv, binding.argv) || plan.cwd !== binding.cwd) {
      throw refused('token-invalid', 'the command or its directory changed since the preview; preview again');
    }
    // Checked again with no await in between: the start is atomic with it.
    if (deps.runs.busy(change.id) !== null) throw refused('run-in-progress', 'an agent run is in progress');
    const runId = deps.runs.start({
      changeId: change.id,
      repoId: change.repoId,
      mode: plan.mode,
      args: plan.args,
      binary: plan.binary,
      cwd: plan.cwd,
      sessionId: plan.session?.sessionId ?? null,
      summary: plan.summary,
      summaryHash: plan.summaryHash,
      timeoutMinutes: plan.timeoutMinutes,
      toolContext: plan.toolContext,
    });
    return reply.status(202).send({ runId });
  });

  http.get<{ Params: IdParams }>('/api/changes/:id/agent/runs', (request, reply): AgentRunsResponse => {
    reply.header('cache-control', 'no-store');
    if (!isSameOrigin(request, deps.port())) throw new HttpError(403, 'forbidden', 'agent runs are for the daemon page only');
    const change = changeOf(request.params.id);
    const current = deps.runs.current(change.id);
    if (current !== null) {
      const log = `${String(change.id)}-${current.runId}.log`;
      return { running: true, latest: { ...current, state: 'running', durationMs: null, exitCode: null, log, message: null } };
    }
    const event = db.events.latest(change.id, 'agent-run');
    return { running: false, latest: event === null ? null : viewOf(event) };
  });

  // The fallback channel (ADR-029): the summary as one fix-queue item for /diffcity-review; nothing is executed.
  http.post<{ Params: IdParams; Body: unknown }>('/api/changes/:id/review/summary/queue', (request) => {
    ownPage(request);
    const change = changeOf(request.params.id);
    const hash = parseHash(request.body);
    if (change.archivedAt !== null) throw refused('archived', `change ${String(change.id)} is archived`);
    const { summary, rewriteMarks, note } = summaryOf(db, change);
    if (rewriteMarks === 0 && (note ?? '').trim() === '') throw refused('nothing-to-send', 'no "Needs rewrite" mark and no general note to send');
    const current = hashOf(summary);
    if (current !== hash) throw refused('summary-changed', 'the summary is not the one shown; look again');
    const item: SummaryQueueItem = { kind: 'review-summary', key: `review-summary:${String(change.id)}:${current.slice(0, 16)}`, message: summary, queuedAt: deps.now().toISOString() };
    const result = appendToFixQueue(fixQueueRoot(change), item);
    if (!result.ok) throw new HttpError(409, result.code, result.message);
    return { key: item.key, queued: result.queued, count: result.count };
  });
}
