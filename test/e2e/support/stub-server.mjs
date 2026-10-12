#!/usr/bin/env node
// Test-only stand-in for the daemon's HTTP side (ADR-017), for the Playwright
// `screens` project and for `npm run dev:ui` without a daemon. It is not the
// daemon: no git, no DB, only 127.0.0.1.
//
// - Serves dist/ui with the SPA fallback to index.html.
// - GET /api/events: a real, held-open SSE stream (`retry: 2000`, `hello`,
//   a `: ping` comment every 15 s). Playwright route mocks cannot hold a
//   stream open, so the specs use this one.
// - Other GET /api/* answer from the JSON fixtures in test/fixtures/ui/. The
//   specs mock these with page.route() anyway, so they do not depend on it.
// - Test controls under /__stub/: `GET health`; `POST sse/drop?client=<id>`
//   closes the SSE streams opened with the cookie `e2e-client=<id>` (all of
//   them without `client`), which is how a spec simulates a lost daemon;
//   `POST sse/emit?event=<name>&client=<id>` with a JSON body sends that event
//   with the body as its data to the same streams, which is how a spec plays
//   a live update.
//
// Usage: node test/e2e/support/stub-server.mjs [--port 4399]

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const uiRoot = join(repoRoot, 'dist', 'ui');
const fixtures = join(repoRoot, 'test', 'fixtures', 'ui');

const portArg = process.argv.indexOf('--port');
const port = portArg === -1 ? 4399 : Number(process.argv[portArg + 1]);
const startedAt = new Date().toISOString();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.json': 'application/json',
};

const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

/** @type {Set<{ client: string | null, res: import('node:http').ServerResponse }>} */
const streams = new Set();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const notFound = (res, message) => json(res, 404, { error: { code: 'not-found', message } });

function clientOf(req) {
  const match = /(?:^|;\s*)e2e-client=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

function openEvents(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ version: 'stub', startedAt })}\n\n`);
  const entry = { client: clientOf(req), res };
  streams.add(entry);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(ping);
    streams.delete(entry);
  });
}

function api(url, res) {
  const path = url.pathname;
  const repos = fixture('fleet-three-repos.json');
  const detail = fixture('repo-mixed-changes.json');
  let match;
  if (path === '/api/health') return json(res, 200, { version: 'stub', pid: process.pid, startedAt, collecting: 0 });
  if (path === '/api/repos') return json(res, 200, repos);
  if ((match = /^\/api\/repos\/(\d+)$/.exec(path))) {
    const repo = repos.find((candidate) => candidate.id === Number(match[1]));
    if (!repo) return notFound(res, 'repo not found');
    return json(res, 200, { repo, changes: repo.id === detail.repo.id ? detail.changes : [] });
  }
  if ((match = /^\/api\/repos\/(\d+)\/changes$/.exec(path))) {
    return json(res, 200, Number(match[1]) === detail.repo.id ? fixture('repo-archived.json') : []);
  }
  if ((match = /^\/api\/changes\/(\d+)$/.exec(path))) {
    const change = [...detail.changes, ...fixture('repo-archived.json')].find((candidate) => candidate.id === Number(match[1]));
    return change ? json(res, 200, change) : notFound(res, 'change not found');
  }
  if ((match = /^\/api\/changes\/(\d+)\/report$/.exec(path))) {
    if (Number(match[1]) === 11) return json(res, 200, fixture('report-order-discounts.json'));
    return json(res, 404, { error: { code: 'no-snapshot', message: 'the stub has a snapshot for change 11 only' } });
  }
  if (path === '/api/search') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const results = fixture('search-results.json').filter((result) =>
      `${result.label} ${result.detail}`.toLowerCase().includes(query),
    );
    return json(res, 200, results);
  }
  return notFound(res, `no route ${path}`);
}

function serveStatic(url, res) {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(uiRoot, relative);
  if (!file.startsWith(uiRoot + sep) && file !== uiRoot) return notFound(res, 'outside dist/ui');
  let stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    file = join(uiRoot, 'index.html');
    stat = statSync(file, { throwIfNoEntry: false });
  }
  if (!stat?.isFile()) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('UI not built; run npm run build');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`);
  if (url.pathname === '/__stub/health') return json(res, 200, { ok: true });
  if (url.pathname === '/__stub/sse/drop' && req.method === 'POST') {
    const client = url.searchParams.get('client');
    let dropped = 0;
    for (const entry of [...streams]) {
      if (client === null || entry.client === client) {
        entry.res.destroy();
        dropped++;
      }
    }
    return json(res, 200, { dropped });
  }
  if (url.pathname === '/__stub/sse/emit' && req.method === 'POST') {
    const event = url.searchParams.get('event');
    const client = url.searchParams.get('client');
    if (!event || !/^[a-z]+(?:-[a-z]+)*$/.test(event)) return json(res, 400, { error: { code: 'bad-event', message: String(event) } });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: { code: 'bad-json', message: 'the body must be JSON' } });
      }
      let sent = 0;
      for (const entry of streams) {
        if (client === null || entry.client === client) {
          entry.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          sent++;
        }
      }
      json(res, 200, { sent });
    });
    return;
  }
  if (req.method !== 'GET') return json(res, 405, { error: { code: 'method-not-allowed', message: req.method ?? '' } });
  if (url.pathname === '/api/events') return openEvents(req, res);
  if (url.pathname.startsWith('/api/')) return api(url, res);
  return serveStatic(url, res);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub server on http://127.0.0.1:${String(port)}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const entry of streams) entry.res.destroy();
    server.close(() => process.exit(0));
  });
}
