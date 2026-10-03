// The review calls of the API client and the ReviewPort (ADR-028): methods,
// JSON bodies, error mapping, and the `review` SSE event.

import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApi } from '../../../src/ui/data/api.js';
import type { Live } from '../../../src/ui/data/live.js';
import { createReviewPort } from '../../../src/ui/data/review-port.js';

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

function stub(answer: (url: string) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init });
    return Promise.resolve(answer(url));
  };
  return { fetch: impl, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ui/review-api-calls', () => {
  it('PUT and DELETE go to the review routes with a JSON body only when there is one', async () => {
    const { fetch, seen } = stub((url) => (url.includes('/marks?') ? new Response(null, { status: 204 }) : json({ mark: {}, progress: {}, note: 'x' })));
    const api = createApi('', fetch);
    await api.putMark(7, { snapshotId: 3, target: { kind: 'file', id: 'f-a' }, mark: 'good' });
    await api.deleteMark(7, { kind: 'symbol', id: 's a&b' });
    await api.putNote(7, 'x');
    expect(seen.map((s) => [s.init?.method, s.url])).toEqual([
      ['PUT', '/api/changes/7/review/marks'],
      ['DELETE', '/api/changes/7/review/marks?kind=symbol&id=s+a%26b'],
      ['PUT', '/api/changes/7/review/note'],
    ]);
    expect(seen[0]?.init?.body).toBe('{"snapshotId":3,"target":{"kind":"file","id":"f-a"},"mark":"good"}');
    expect((seen[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(seen[1]?.init?.body).toBeUndefined();
    expect((seen[1]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(seen[2]?.init?.body).toBe('{"note":"x"}');
  });

  it('409 no-snapshot is null for the review and the summary; other errors keep their code', async () => {
    const { fetch } = stub((url) => {
      if (url.endsWith('/marks')) return json({ error: { code: 'snapshot-moved', message: 'moved' } }, 409);
      return json({ error: { code: 'no-snapshot', message: 'none' } }, 409);
    });
    const api = createApi('', fetch);
    expect(await api.review(1)).toBeNull();
    expect(await api.reviewSummary(1)).toBeNull();
    const error = await api.putMark(1, { snapshotId: 1, target: { kind: 'file', id: 'f' }, mark: 'checked' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, code: 'snapshot-moved' });
  });

  it('the summary is the markdown text', async () => {
    const { fetch } = stub(() => new Response('# Review\n', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }));
    expect(await createApi('', fetch).reviewSummary(2)).toBe('# Review\n');
  });
});

describe('ui/review-port', () => {
  it('onChange fires for the review event of its change and after a hello, never for another change', () => {
    const listeners = new Map<string, ((data: never) => void)[]>();
    const live = {
      on: (event: string, listener: (data: never) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return () => undefined;
      },
    } as unknown as Live;
    const { fetch } = stub(() => json({}));
    const port = createReviewPort(createApi('', fetch), live, 5);
    let calls = 0;
    port.onChange(() => {
      calls += 1;
    });
    const emit = (event: string, data: unknown): void => {
      for (const listener of listeners.get(event) ?? []) (listener as (payload: unknown) => void)(data);
    };
    emit('review', { repoId: 1, changeId: 6 });
    expect(calls).toBe(0);
    emit('review', { repoId: 1, changeId: 5 });
    emit('hello', { version: '1', startedAt: 'x' });
    expect(calls).toBe(2);
  });
});

describe('ui/review-port-methods', () => {
  it('setMark, clearMark and setNote call the review routes of their change', async () => {
    const { fetch, seen } = stub((url) => (url.includes('/marks?') ? new Response(null, { status: 204 }) : json({ mark: {}, progress: {}, note: null })));
    const port = createReviewPort(createApi('', fetch), {} as Live, 9);
    await port.setMark({ snapshotId: 1, target: { kind: 'file', id: 'f' }, mark: 'checked' });
    await port.clearMark({ kind: 'file', id: 'f' });
    await port.setNote('');
    expect(seen.map((s) => [s.init?.method, s.url])).toEqual([
      ['PUT', '/api/changes/9/review/marks'],
      ['DELETE', '/api/changes/9/review/marks?kind=file&id=f'],
      ['PUT', '/api/changes/9/review/note'],
    ]);
  });
});
