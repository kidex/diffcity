// The findings calls of the API client and the FindingsPort (ADR-036): routes
// and methods with the key as one encoded path segment, the JSON body only on
// the state write, every error answer as a refusal with the daemon's message
// (403 `cross-site` with its own), only a request with no answer as a
// rejection, and the refetch hook after an accepted write only.

import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApi } from '../../../src/ui/data/api.js';
import { createFindingsPort, CROSS_SITE } from '../../../src/ui/data/findings-port.js';

interface Seen {
  url: string;
  init: RequestInit | undefined;
}

function stub(answer: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, init });
    return answer(url);
  };
  return { fetch: impl, seen };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ui/findings-port', () => {
  it('PUT state and POST fix go to the finding routes, the key encoded', async () => {
    const { fetch, seen } = stub((url) => (url.endsWith('/fix') ? json({ key: 'rule:size:0b', queued: true, count: 1 }) : json({ key: 'rule:size:0b', state: 'intended', keys: ['rule:size:0b'] })));
    const api = createApi('', fetch);
    expect(await api.setFindingState(7, 'rule:size:0b', 'intended')).toEqual({ key: 'rule:size:0b', state: 'intended', keys: ['rule:size:0b'] });
    expect(await api.fixFinding(7, 'f:a/b?c')).toEqual({ key: 'rule:size:0b', queued: true, count: 1 });
    expect(seen.map((s) => [s.init?.method, s.url])).toEqual([
      ['PUT', '/api/changes/7/findings/rule%3Asize%3A0b/state'],
      ['POST', '/api/changes/7/findings/f%3Aa%2Fb%3Fc/fix'],
    ]);
    expect(seen[0]?.init?.body).toBe('{"state":"intended"}');
    expect((seen[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(seen[1]?.init?.body).toBeUndefined();
    expect((seen[1]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('an error answer is a refusal with its message; no answer rejects; only an accepted write refetches', async () => {
    let written = 0;
    const { fetch } = stub((url) => {
      if (url.includes('/unsafe/')) return json({ error: { code: 'fix-queue-unsafe', message: '.diffcity/fix-queue.json is a symlink' } }, 409);
      if (url.includes('/gone/')) return json({ error: { code: 'finding-not-found', message: 'no finding gone' } }, 404);
      if (url.includes('/foreign/')) return json({ error: { code: 'cross-site', message: 'cross-site write refused' } }, 403);
      if (url.includes('/down/')) return Promise.reject(new TypeError('Failed to fetch'));
      return json({ key: 'ok', queued: false, count: 2 });
    });
    const port = createFindingsPort(createApi('', fetch), 3, () => {
      written += 1;
    });
    expect(await port.ask('unsafe')).toEqual({ ok: false, refusal: { code: 'fix-queue-unsafe', message: '.diffcity/fix-queue.json is a symlink' } });
    expect(written).toBe(0);
    expect(await port.setState('gone', 'open')).toEqual({ ok: false, refusal: { code: 'finding-not-found', message: 'no finding gone' } });
    expect(await port.ask('foreign')).toEqual({ ok: false, refusal: { code: 'cross-site', message: CROSS_SITE } });
    expect(CROSS_SITE).toBe('Open diffcity from the address `diffcity start` prints.');
    // A network failure is not an ApiRequestError: it rejects, and the screen shows the generic line.
    const down = await port.ask('down').catch((error: unknown) => error);
    expect(down).not.toBeInstanceOf(ApiRequestError);
    expect(down).toBeInstanceOf(TypeError);
    expect(written).toBe(0);
    // Already queued (`queued: false`) is an accepted answer like any other.
    const before = performance.now();
    const accepted = await port.ask('ok');
    expect(accepted).toMatchObject({ ok: true, value: { key: 'ok', queued: false, count: 2 } });
    // `at`: when the answer arrived, so a Report fetched after it is known to be newer.
    expect(accepted.ok && accepted.at >= before).toBe(true);
    expect(written).toBe(1);
  });
});
