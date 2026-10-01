// Typed client for the daemon's JSON API (ADR-017). The DTOs come from
// src/core/model/types.ts as types only (ADR-022). The change screen never
// imports this module: it renders from a Report alone (ADR-002).

import type {
  ApiError,
  ChangeSummary,
  HealthResponse,
  RepoDetail,
  RepoSummary,
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

export interface Api {
  health(signal?: AbortSignal): Promise<HealthResponse>;
  repos(signal?: AbortSignal): Promise<RepoSummary[]>;
  repo(id: number, signal?: AbortSignal): Promise<RepoDetail>;
  archivedChanges(repoId: number, signal?: AbortSignal): Promise<ChangeSummary[]>;
  change(id: number, signal?: AbortSignal): Promise<ChangeSummary>;
  /** The latest snapshot's Report, or null while it is being computed (404 `no-snapshot`). */
  report(changeId: number, signal?: AbortSignal): Promise<Report | null>;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

function isApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const { error } = body;
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

/** `base` is the URL prefix of `/api`; empty for the page served by the daemon. */
export function createApi(base = '', fetchImpl: typeof fetch = (...args) => fetch(...args)): Api {
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const init: RequestInit = { headers: { accept: 'application/json' } };
    if (signal) init.signal = signal;
    const response = await fetchImpl(`${base}/api${path}`, init);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isApiError(body)) throw new ApiRequestError(response.status, body.error.code, body.error.message);
      throw new ApiRequestError(response.status, 'http-error', `${String(response.status)} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

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
    search(query, { limit = 20, signal } = {}) {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      return get<SearchResult[]>(`/search?${params.toString()}`, signal);
    },
  };
}
