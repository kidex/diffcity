// Typed client for the daemon's JSON API (ADR-017). The DTOs come from
// src/core/model/types.ts as types only (ADR-022). The change screen never
// imports this module: it renders from a Report alone (ADR-002).

import type {
  ApiError,
  ChangeSummary,
  FileDiff,
  HealthResponse,
  RepoDetail,
  RepoSummary,
  ReviewMark,
  ReviewMarkValue,
  ReviewProgress,
  SearchResult,
} from '../../core/model/types.js';
import type { Report } from '../../core/report/types.js';

/** A non-2xx answer from the API, with the `{ error: { code, message } }` body when there is one. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** `GET /api/changes/:id/review` (ADR-028). */
export interface ReviewState {
  snapshotId: number;
  marks: ReviewMark[];
  note: string | null;
  progress: ReviewProgress;
}

/** The body of `PUT /api/changes/:id/review/marks`; the snapshot is the one the reviewer is looking at. */
export interface MarkRequest {
  snapshotId: number;
  target: { kind: 'file' | 'symbol'; id: string };
  mark: ReviewMarkValue;
  note?: string;
  lines?: { side: 'old' | 'new'; start: number; end: number };
}

export interface Api {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  repos(signal?: AbortSignal): Promise<RepoSummary[]>;
  repo(id: number, signal?: AbortSignal): Promise<RepoDetail>;
  archivedChanges(repoId: number, signal?: AbortSignal): Promise<ChangeSummary[]>;
  change(id: number, signal?: AbortSignal): Promise<ChangeSummary>;
  /** The latest snapshot's Report, or null while it is being computed (404 `no-snapshot`). */
  report(changeId: number, signal?: AbortSignal): Promise<Report | null>;
  /** The marks, general note and progress of a change; null while it has no snapshot (409 `no-snapshot`). */
  review(changeId: number, signal?: AbortSignal): Promise<ReviewState | null>;
  /** Makes or replaces a mark; rejects with ApiRequestError `snapshot-moved`, `target-not-found`, `archived`. */
  putMark(changeId: number, request: MarkRequest): Promise<{ mark: ReviewMark; progress: ReviewProgress }>;
  /** Undoes a mark, outdated or not. */
  deleteMark(changeId: number, target: MarkRequest['target']): Promise<void>;
  /** Sets the general note; the empty string clears it. */
  putNote(changeId: number, note: string): Promise<{ note: string | null }>;
  /** The markdown summary of the "Needs rewrite" marks; null while the change has no snapshot. */
  reviewSummary(changeId: number, signal?: AbortSignal): Promise<string | null>;
  /**
   * The diff of one file of the latest snapshot (ADR-027); `path` is a `File.id`, `symbol` a `Symbol.id` of that
   * file to focus. Rejects with ApiRequestError: 404 `not-in-snapshot`, `no-snapshot` or `not-found`, 400, 403.
   */
  diff(changeId: number, path: string, symbol?: string, signal?: AbortSignal): Promise<FileDiff>;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

function isApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body;
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

/** `base` is the URL prefix of `/api`; empty for the page served by the daemon. */
export function createApi(base = '', fetchImpl: typeof fetch = (...args) => fetch(...args)): Api {
  async function fail(response: Response): Promise<never> {
    const body: unknown = await response.json().catch(() => null);
    if (isApiError(body)) throw new ApiRequestError(response.status, body.error.code, body.error.message);
    throw new ApiRequestError(response.status, 'http-error', `${String(response.status)} ${response.statusText}`);
  }

  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { headers: { accept: 'application/json' } };
    if (signal) init.signal = signal;
    const response = await fetchImpl(`${base}/api${path}`, init);
    if (!response.ok) return fail(response);
    return (await response.json()) as T;
  }

  /** A write: the browser adds `Origin`; the daemon wants JSON for a body (ADR-028 write guard). */
  async function write(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(`${base}/api${path}`, init);
    if (!response.ok) return fail(response);
    return response;
  }

  const reviewPath = (changeId: number): string => `/changes/${String(changeId)}/review`;

  return {
    health: (signal) => get<HealthResponse>('/health', signal),
    repos: (signal) => get<RepoSummary[]>('/repos', signal),
    repo: (id, signal) => get<RepoDetail>(`/repos/${String(id)}`, signal),
    archivedChanges: (repoId, signal) => get<ChangeSummary[]>(`/repos/${String(repoId)}/changes?archived=1`, signal),
    change: (id, signal) => get<ChangeSummary>(`/changes/${String(id)}`, signal),
    async report(changeId, signal) {
      try {
        return await get<Report>(`/changes/${String(changeId)}/report`, signal);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404 && error.code === 'no-snapshot') return null;
        throw error;
      }
    },
    async review(changeId, signal) {
      try {
        return await get<ReviewState>(reviewPath(changeId), signal);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409 && error.code === 'no-snapshot') return null;
        throw error;
      }
    },
    async putMark(changeId, request) {
      return (await (await write('PUT', `${reviewPath(changeId)}/marks`, request)).json()) as { mark: ReviewMark; progress: ReviewProgress };
    },
    async deleteMark(changeId, target) {
      const params = new URLSearchParams({ kind: target.kind, id: target.id });
      await write('DELETE', `${reviewPath(changeId)}/marks?${params.toString()}`);
    },
    async putNote(changeId, note) {
      return (await (await write('PUT', `${reviewPath(changeId)}/note`, { note })).json()) as { note: string | null };
    },
    async reviewSummary(changeId, signal) {
      const init: RequestInit = { headers: { accept: 'text/markdown' } };
      if (signal) init.signal = signal;
      const response = await fetchImpl(`${base}/api${reviewPath(changeId)}/summary`, init);
      if (response.status === 409) {
        const body: unknown = await response.json().catch(() => null);
        if (isApiError(body) && body.error.code === 'no-snapshot') return null;
        throw new ApiRequestError(response.status, isApiError(body) ? body.error.code : 'http-error', isApiError(body) ? body.error.message : response.statusText);
      }
      if (!response.ok) return fail(response);
      return response.text();
    },
    diff(changeId, path, symbol, signal) {
      const params = new URLSearchParams({ path });
      if (symbol !== undefined) params.set('symbol', symbol);
      return get<FileDiff>(`/changes/${String(changeId)}/diff?${params.toString()}`, signal);
    },
    search(query, { limit = 20, signal } = {}) {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      return get<SearchResult[]>(`/search?${params.toString()}`, signal);
    },
  };
}
