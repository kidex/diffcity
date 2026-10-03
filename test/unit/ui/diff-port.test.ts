// The diff call of the API client and the DiffPort (ADR-027): URL, encoding,
// the answer as it is, and error mapping.

import { describe, expect, it } from 'vitest';
import { ApiRequestError, createApi } from '../../../src/ui/data/api.js';
import { createDiffPort } from '../../../src/ui/data/diff-port.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(answer: (url: string) => Response): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve(answer(url));
  };
  return { fetch: impl, urls };
}

describe('ui/diff-api-call', () => {
  it('asks for the path, and the symbol only when given, encoded', async () => {
    const diff = { kind: 'text', path: 'src/a b.ts', rows: [] };
    const { fetch, urls } = stub(() => json(diff));
    const api = createApi('', fetch);
    expect(await api.diff(7, 'src/a b.ts')).toEqual(diff);
    await api.diff(7, 'src/a b.ts', 'src/a b.ts#f&g');
    expect(urls).toEqual(['/api/changes/7/diff?path=src%2Fa+b.ts', '/api/changes/7/diff?path=src%2Fa+b.ts&symbol=src%2Fa+b.ts%23f%26g']);
  });

  it('keeps the code of a refusal', async () => {
    const { fetch } = stub(() => json({ error: { code: 'not-in-snapshot', message: 'no' } }, 404));
    const error = await createApi('', fetch).diff(1, 'x.ts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 404, code: 'not-in-snapshot' });
  });

  it('the port is bound to its change', async () => {
    const { fetch, urls } = stub(() => json({ kind: 'unchanged' }));
    const port = createDiffPort(createApi('', fetch), 12);
    expect(await port.fileDiff('src/a.ts', 'src/a.ts#f')).toEqual({ kind: 'unchanged' });
    expect(urls).toEqual(['/api/changes/12/diff?path=src%2Fa.ts&symbol=src%2Fa.ts%23f']);
  });
});
