// The review routes of the mock API (ADR-028) for the screens project. They
// apply the daemon's rules simply, by calling the same pure functions the
// daemon uses (src/core/review): validation (400), targets in the latest
// snapshot only (404 `target-not-found`), `snapshot-moved` (409) when the
// request's snapshot is not the latest and the target changed between the two,
// progress and the summary. Nothing here is the UI's: it stands in for the
// daemon, state kept per change for the life of one page.

import type { Route } from '@playwright/test';
import type { ApiError, ReviewMark } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { computeProgress, renderSummary, validateGeneralNote, validateMarkInput } from '../../../src/core/review/index.js';

/** One write the page made, as the route saw it. */
export interface ReviewWrite {
  method: 'PUT' | 'DELETE';
  /** The path under /api/changes/:id/review, e.g. `/marks`. */
  path: string;
  /** The query string of a DELETE, as `kind=...&id=...`. */
  query: string;
  body: unknown;
}

/** What a spec may set before the page opens. */
export interface ReviewSeed {
  snapshotId?: number;
  marks?: ReviewMark[];
  note?: string | null;
}

export interface ReviewMock {
  /** The latest snapshot's id. */
  snapshotId: number;
  marks: ReviewMark[];
  note: string | null;
  /** Targets whose content changed in the latest snapshot, by id: a mark request made against an older snapshot on one of them is refused. */
  changed: Set<string>;
  /** Every write the page made, in order. */
  readonly writes: ReviewWrite[];
  /** Reads of `GET /review`. */
  reads: number;
  /** Answers the next write (once) with this status and error code, whatever it is. */
  failNext: { status: number; code: string } | null;
  /** Holds every write until it is called (a slow daemon): the page shows its optimistic state meanwhile. */
  hold: Promise<void> | null;
  /** The newest snapshot changed `ids` (files or symbols): marks on them go outdated, and writes against the old snapshot on them get 409. */
  moveSnapshot(ids: string[]): void;
}

export function createReviewMock(seed: ReviewSeed = {}): ReviewMock {
  const mock: ReviewMock = {
    snapshotId: seed.snapshotId ?? 1,
    marks: seed.marks ?? [],
    note: seed.note ?? null,
    changed: new Set(),
    writes: [],
    reads: 0,
    failNext: null,
    hold: null,
    moveSnapshot(ids) {
      mock.snapshotId += 1;
      for (const id of ids) mock.changed.add(id);
      const now = new Date().toISOString();
      mock.marks = mock.marks.map((mark) => (ids.includes(mark.targetId) && mark.state === 'current' ? { ...mark, state: 'outdated', outdatedAt: now } : mark));
    },
  };
  return mock;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const error = (code: string, message: string): ApiError => ({ error: { code, message } });

/** The targets of `report` the daemon would let a reviewer mark: touched files and every symbol of one. */
function markable(report: Report): Map<string, { kind: 'file' | 'symbol'; filePath: string }> {
  const targets = new Map<string, { kind: 'file' | 'symbol'; filePath: string }>();
  for (const file of report.packages.flatMap((pkg) => pkg.files)) {
    if (file.status === 'same') continue;
    targets.set(`file:${file.id}`, { kind: 'file', filePath: file.path });
    for (const symbol of file.symbols) targets.set(`symbol:${symbol.id}`, { kind: 'symbol', filePath: file.path });
  }
  return targets;
}

/** Answers one request of `/api/changes/:id/review...`; `rest` is what follows `/review`. */
export async function answerReview(route: Route, mock: ReviewMock, report: Report | undefined, rest: string): Promise<void> {
  const request = route.request();
  const method = request.method();
  const url = new URL(request.url());
  const json = (body: unknown, status = 200): Promise<void> => route.fulfill({ status, json: body });

  if (report === undefined) return json(error('no-snapshot', 'no snapshot yet'), 409);
  const progress = () => computeProgress(report, mock.marks);

  if (method === 'GET' && rest === '') {
    mock.reads += 1;
    return json({ snapshotId: mock.snapshotId, marks: mock.marks, note: mock.note, progress: progress() });
  }
  if (method === 'GET' && rest === '/summary') {
    const text = renderSummary({ ref: report.meta.head, repoName: report.meta.repo, head: 'aaaaaaa1111', note: mock.note, report, marks: mock.marks });
    return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', body: text });
  }
  if (method !== 'PUT' && method !== 'DELETE') return json(error('not-found', 'no such review route'), 404);

  let body: unknown = null;
  if (method === 'PUT') {
    try {
      body = request.postDataJSON() as unknown;
    } catch {
      return json(error('bad-request', 'the body is not JSON'), 400);
    }
  }
  mock.writes.push({ method, path: rest, query: url.searchParams.toString(), body });
  if (mock.hold !== null) await mock.hold;
  if (mock.failNext !== null) {
    const { status, code } = mock.failNext;
    mock.failNext = null;
    return json(error(code, `mock: ${code}`), status);
  }

  const targets = markable(report);
  if (method === 'PUT' && rest === '/marks') {
    // A "Needs rewrite" mark needs no note (DC-135): a body without one is checked as any other mark.
    const noteless = isRecord(body) && body['mark'] === 'rewrite' && (typeof body['note'] !== 'string' || body['note'].trim() === '');
    const checked = validateMarkInput(noteless && isRecord(body) ? { ...body, mark: 'checked', note: undefined } : body);
    const input = checked.ok && noteless ? { ok: true as const, value: { ...checked.value, mark: 'rewrite' as const, note: null } } : checked;
    if (!input.ok) return json(error('bad-request', input.message), 400);
    const { target, mark, note, lines, snapshotId } = input.value;
    const known = targets.get(`${target.kind}:${target.id}`);
    if (known === undefined) return json(error('target-not-found', 'not in the latest snapshot, or not markable'), 404);
    if (snapshotId !== mock.snapshotId && mock.changed.has(target.id)) return json(error('snapshot-moved', 'the target changed in a newer snapshot'), 409);
    const now = new Date().toISOString();
    const previous = mock.marks.find((other) => other.targetKind === target.kind && other.targetId === target.id);
    const saved: ReviewMark = {
      targetKind: target.kind,
      targetId: target.id,
      filePath: known.filePath,
      mark,
      note,
      lines,
      state: 'current',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      outdatedAt: null,
    };
    mock.marks = [...mock.marks.filter((other) => other !== previous), saved];
    return json({ mark: saved, progress: progress() });
  }
  if (method === 'DELETE' && rest === '/marks') {
    const kind = url.searchParams.get('kind');
    const id = url.searchParams.get('id');
    const found = mock.marks.find((other) => other.targetKind === kind && other.targetId === id);
    if (found === undefined) return json(error('not-found', 'no such mark'), 404);
    mock.marks = mock.marks.filter((other) => other !== found);
    return route.fulfill({ status: 204 });
  }
  if (method === 'PUT' && rest === '/note') {
    const input = validateGeneralNote(body);
    if (!input.ok) return json(error('bad-request', input.message), 400);
    mock.note = input.value.trim() === '' ? null : input.value;
    return json({ note: mock.note });
  }
  return json(error('not-found', 'no such review route'), 404);
}

/** A mark of the seed, current unless `state` says otherwise. */
export function seedMark(
  report: Report,
  targetKind: 'file' | 'symbol',
  targetId: string,
  mark: ReviewMark['mark'],
  extra: Partial<Pick<ReviewMark, 'note' | 'lines' | 'state'>> = {},
): ReviewMark {
  const file = report.packages.flatMap((pkg) => pkg.files).find((candidate) => (targetKind === 'file' ? candidate.id === targetId : candidate.symbols.some((symbol) => symbol.id === targetId)));
  const state = extra.state ?? 'current';
  return {
    targetKind,
    targetId,
    filePath: file?.path ?? targetId,
    mark,
    note: extra.note ?? (mark === 'rewrite' ? 'Rewrite this.' : null),
    lines: extra.lines ?? null,
    state,
    createdAt: '2026-05-04T11:00:00.000Z',
    updatedAt: '2026-05-04T11:00:00.000Z',
    outdatedAt: state === 'outdated' ? '2026-05-04T11:30:00.000Z' : null,
  };
}

/** The marks a `{ files, symbols }` overlay of the scene's kinds stands for (`outdated` keeps the mark `checked`). */
export function marksFromOverlay(report: Report, overlay: { files?: Record<string, string>; symbols?: Record<string, string> }): ReviewMark[] {
  const make = (kind: 'file' | 'symbol', id: string, value: string): ReviewMark =>
    seedMark(report, kind, id, value === 'outdated' ? 'checked' : (value as ReviewMark['mark']), { state: value === 'outdated' ? 'outdated' : 'current' });
  return [
    ...Object.entries(overlay.files ?? {}).map(([id, value]) => make('file', id, value)),
    ...Object.entries(overlay.symbols ?? {}).map(([id, value]) => make('symbol', id, value)),
  ];
}
