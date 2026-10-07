// The findings routes of the mock API (ADR-036) for the screens project, as
// built in DC-100: `PUT /api/changes/:id/findings/:key/state` and `POST
// /api/changes/:id/findings/:key/fix`. They stand in for the daemon simply: a
// state write sets the finding's state in the Report the mock serves and
// recomputes the file verdicts with the daemon's own `fileVerdict`, so the
// refetched Report says what the served one would; a fix keeps a queue of
// keys. Nothing here is the UI's.

import type { Route } from '@playwright/test';
import type { ApiError } from '../../../src/core/model/types.js';
import type { Report, Verdict } from '../../../src/core/report/types.js';
import { fileVerdict } from '../../../src/core/verdict/index.js';

/** One write the page made, as the route saw it. */
export interface FindingsWrite {
  method: string;
  /** The key, decoded from the path. */
  key: string;
  action: 'state' | 'fix';
  body: unknown;
}

export interface FindingsMock {
  /** Every write the page made, in order. */
  readonly writes: FindingsWrite[];
  /** Keys in the fix queue. */
  queued: Set<string>;
  /** Answers the next write (once) with this status, code and message, whatever it is. */
  failNext: { status: number; code: string; message: string } | null;
  /** Aborts the next write (once) as a dropped connection would. */
  dropNext: boolean;
  /** Holds every write until it settles (a slow daemon). */
  hold: Promise<void> | null;
}

export function createFindingsMock(): FindingsMock {
  return { writes: [], queued: new Set(), failNext: null, dropNext: false, hold: null };
}

const error = (code: string, message: string): ApiError => ({ error: { code, message } });

/** Recomputes every file verdict and `summary.byVerdict` of `report` in place, as the daemon's overlay does. */
export function recomputeVerdicts(report: Report): Report {
  const tier1 = new Set(report.summary.tier1Files);
  const byVerdict: Record<Verdict, number> = { eyes: 0, risky: 0, spec: 0, ok: 0, same: 0 };
  for (const file of report.packages.flatMap((pkg) => pkg.files)) {
    file.verdict = fileVerdict({
      status: file.status,
      symbolStatuses: file.symbols.map((symbol) => symbol.status),
      tier1: tier1.has(file.path),
      findings: report.findings.filter((finding) => finding.file === file.path),
      inSpec: file.inSpec,
    });
    byVerdict[file.verdict] += 1;
  }
  report.summary.byVerdict = byVerdict;
  return report;
}

/** Sets the state of finding `key` in `report` and recomputes the verdicts: the served Report after a state write. */
export function setFindingState(report: Report, key: string, state: 'open' | 'intended' | 'fixed'): Report {
  const finding = report.findings.find((candidate) => candidate.id === key);
  if (finding === undefined) throw new Error(`no finding ${key}`);
  finding.state = state;
  return recomputeVerdicts(report);
}

/** Answers one request of `/api/changes/:id/findings/:key/:action`. */
export async function answerFindings(route: Route, mock: FindingsMock, report: Report | undefined, key: string, action: string): Promise<void> {
  const request = route.request();
  const method = request.method();
  const json = (body: unknown, status = 200): Promise<void> => route.fulfill({ status, json: body });
  const expected = action === 'state' ? 'PUT' : action === 'fix' ? 'POST' : null;
  if (expected === null || method !== expected) return json(error('not-found', 'no such findings route'), 404);

  let body: unknown = null;
  if (method === 'PUT') {
    try {
      body = request.postDataJSON() as unknown;
    } catch {
      return json(error('bad-request', 'the body is not JSON'), 400);
    }
  }
  mock.writes.push({ method, key, action: action === 'state' ? 'state' : 'fix', body });
  if (mock.hold !== null) await mock.hold;
  if (mock.dropNext) {
    mock.dropNext = false;
    return route.abort('connectionreset');
  }
  if (mock.failNext !== null) {
    const { status, code, message } = mock.failNext;
    mock.failNext = null;
    return json(error(code, message), status);
  }
  if (report === undefined) return json(error('no-snapshot', 'no snapshot yet'), 409);
  const finding = report.findings.find((candidate) => candidate.id === key);
  if (finding === undefined) return json(error('finding-not-found', `no finding ${key}`), 404);

  if (action === 'state') {
    const state = (body as { state?: unknown } | null)?.state;
    if (state !== 'open' && state !== 'intended') return json(error('bad-request', 'state must be open or intended'), 400);
    setFindingState(report, key, state);
    return json({ key, state, keys: [key] });
  }
  const queued = !mock.queued.has(key);
  mock.queued.add(key);
  return json({ key, queued, count: mock.queued.size });
}
