// The HTTP server (ADR-017): 127.0.0.1 only, the Host check, JSON errors,
// /api/health, /api/events, static dist/ui with SPA fallback and the
// "UI not built" page. Requests go through fastify.inject, except SSE.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { buildHttpServer, HttpError } from '../../../src/daemon/http/server.js';
import { createSseHub, type SseHub } from '../../../src/daemon/sse.js';

const PORT = 4321;
const HOST = { host: `127.0.0.1:${String(PORT)}` };
const startedAt = '2026-01-01T00:00:00.000Z';

let dir: string;
let app: FastifyInstance | undefined;
let hub: SseHub;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-http-'));
  hub = createSseHub({ hello: () => ({ version: '9.9.9', startedAt }) });
});
afterEach(async () => {
  hub.close();
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function build(options: { uiDir?: string; port?: () => number } = {}): Promise<FastifyInstance> {
  app = await buildHttpServer({
    version: '9.9.9',
    pid: 123,
    startedAt,
    uiDir: options.uiDir ?? join(dir, 'no-ui'),
    sse: hub,
    collecting: () => 2,
    log: createStreamLogger(new PassThrough()),
    port: options.port ?? (() => PORT),
  });
  return app;
}

async function builtUi(): Promise<string> {
  const ui = join(dir, 'ui');
  await mkdir(join(ui, 'assets'), { recursive: true });
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>diffcity</title><div id="app"></div>\n');
  await writeFile(join(ui, 'assets', 'app.js'), 'console.log("app");\n');
  return ui;
}

describe('api/health', () => {
  it('answers with version, pid, startedAt and collecting', async () => {
    const server = await build();
    const response = await server.inject({ method: 'GET', url: '/api/health', headers: HOST });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ version: '9.9.9', pid: 123, startedAt, collecting: 2 });
  });
});

describe('api/host-header-rejected', () => {
  it.each(['evil.example', 'evil.example:4321', '127.0.0.1:9999', 'localhost', '[::1]:4321', '127.0.0.2:4321'])(
    'Host %s gets 421 with a JSON error',
    async (host) => {
      const server = await build();
      const response = await server.inject({ method: 'GET', url: '/api/health', headers: { host } });
      expect(response.statusCode).toBe(421);
      expect(response.json()).toEqual({ error: { code: 'misdirected-request', message: expect.any(String) as unknown } });
    },
  );

  it.each(['127.0.0.1:4321', 'localhost:4321', 'LOCALHOST:4321'])('Host %s is accepted', async (host) => {
    const server = await build();
    const response = await server.inject({ method: 'GET', url: '/api/health', headers: { host } });
    expect(response.statusCode).toBe(200);
  });

  it('also guards the UI', async () => {
    const server = await build({ uiDir: await builtUi() });
    const response = await server.inject({ method: 'GET', url: '/', headers: { host: 'evil.example:4321' } });
    expect(response.statusCode).toBe(421);
  });
});

describe('JSON errors', () => {
  it('an unknown /api route is a JSON 404', async () => {
    const server = await build({ uiDir: await builtUi() });
    for (const url of ['/api/nope', '/api', '/api/repos/1/whatever']) {
      const response = await server.inject({ method: 'GET', url, headers: HOST });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'not-found', message: expect.any(String) as unknown } });
    }
  });

  it('HttpError keeps its status and code; any other error is a 500 without details', async () => {
    const server = await build();
    server.get('/api/test/http-error', () => {
      throw new HttpError(404, 'no-snapshot', 'no snapshot yet');
    });
    server.get('/api/test/crash', () => {
      throw new Error('secret internals');
    });
    const known = await server.inject({ method: 'GET', url: '/api/test/http-error', headers: HOST });
    expect(known.statusCode).toBe(404);
    expect(known.json()).toEqual({ error: { code: 'no-snapshot', message: 'no snapshot yet' } });
    const crash = await server.inject({ method: 'GET', url: '/api/test/crash', headers: HOST });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ error: { code: 'internal', message: 'internal server error' } });
  });

  it('a non-GET request needs the daemon Origin, same-origin Fetch metadata and, with a body, JSON', async () => {
    const server = await build();
    server.post('/api/test/action', () => ({ done: true }));
    const url = '/api/test/action';
    const payload = '{}';
    const json = { 'content-type': 'application/json' };

    const noOrigin = await server.inject({ method: 'POST', url, payload, headers: { ...HOST, ...json } });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json()).toMatchObject({ error: { code: 'cross-site' } });

    const foreign = await server.inject({ method: 'POST', url, payload, headers: { ...HOST, ...json, origin: 'http://evil.example' } });
    expect(foreign.statusCode).toBe(403);

    const form = await server.inject({
      method: 'POST',
      url,
      payload: 'a=1',
      headers: { ...HOST, origin: 'http://127.0.0.1:4321', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
    expect(form.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });

    const fetchSite = await server.inject({
      method: 'POST',
      url,
      payload,
      headers: { ...HOST, ...json, origin: 'http://127.0.0.1:4321', 'sec-fetch-site': 'same-site' },
    });
    expect(fetchSite.statusCode).toBe(403);
    expect(fetchSite.json()).toMatchObject({ error: { code: 'cross-site' } });

    const ok = await server.inject({ method: 'POST', url, payload, headers: { ...HOST, ...json, origin: 'http://localhost:4321' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ done: true });
  });
});

describe('api/spa-fallback', () => {
  it('serves index.html at /, files from dist/ui, and index.html for unknown routes', async () => {
    const server = await build({ uiDir: await builtUi() });
    const root = await server.inject({ method: 'GET', url: '/', headers: HOST });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toMatch(/^text\/html/);
    expect(root.body).toContain('<div id="app">');

    const asset = await server.inject({ method: 'GET', url: '/assets/app.js', headers: HOST });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);

    for (const url of ['/repo/12', '/some/deep/route?x=1']) {
      const fallback = await server.inject({ method: 'GET', url, headers: HOST });
      expect(fallback.statusCode).toBe(200);
      expect(fallback.headers['content-type']).toMatch(/^text\/html/);
      expect(fallback.body).toContain('<div id="app">');
    }
  });

  it('does not serve files outside dist/ui', async () => {
    const ui = await builtUi();
    await writeFile(join(dir, 'secret.txt'), 'outside');
    const server = await build({ uiDir: ui });
    const response = await server.inject({ method: 'GET', url: '/../secret.txt', headers: HOST });
    expect(response.body).not.toContain('outside');
  });
});

describe('api/ui-not-built', () => {
  it('without dist/ui, pages get the explanatory page and the API keeps working', async () => {
    const server = await build({ uiDir: join(dir, 'missing') });
    for (const url of ['/', '/repo/1']) {
      const page = await server.inject({ method: 'GET', url, headers: HOST });
      expect(page.statusCode).toBe(503);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.body).toContain('UI not built; run npm run build');
    }
    const health = await server.inject({ method: 'GET', url: '/api/health', headers: HOST });
    expect(health.statusCode).toBe(200);
  });
});

describe('sse over HTTP', () => {
  it('GET /api/events streams hello as text/event-stream', async () => {
    let port = 0;
    const server = await build({ port: () => port });
    await server.listen({ host: '127.0.0.1', port: 0 });
    port = (server.server.address() as AddressInfo).port;

    const { headers, body } = await new Promise<{ headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port, path: '/api/events' }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('event: hello')) {
            resolve({ headers: response.headers, body: text });
            request.destroy();
          }
        });
      });
      request.on('error', reject);
    });
    expect(headers['content-type']).toMatch(/^text\/event-stream/);
    expect(headers['cache-control']).toBe('no-cache');
    expect(body).toContain('retry: 2000');
    expect(body).toContain(`event: hello\ndata: ${JSON.stringify({ version: '9.9.9', startedAt })}`);
  });
});
