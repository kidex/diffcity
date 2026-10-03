// The daemon's HTTP server (ADR-017): Fastify on 127.0.0.1, a Host check
// against DNS rebinding, the write guard for non-GET requests (Origin, Sec-Fetch-Site, JSON; 403 `cross-site` or 415), JSON errors,
// /api/health, /api/events (SSE) and the UI from dist/ui with an index.html
// fallback. More /api routes are added by daemon plugins (src/daemon/plugins.ts)
// before the server listens.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { HealthResponse } from '../../core/model/types.js';
import { errorMessage, type Logger } from '../log.js';
import type { SseHub } from '../sse.js';
import { codeForStatus, HttpError, sendError } from './errors.js';

export { HttpError, sendError, apiError } from './errors.js';

/** The only address the daemon listens on. */
export const HTTP_HOST = '127.0.0.1';

export const UI_NOT_BUILT_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>diffcity</title></head>
<body><p>UI not built; run npm run build</p></body>
</html>
`;

export interface HttpServerOptions {
  version: string;
  pid: number;
  startedAt: string;
  /** The built UI (dist/ui); it may be missing. */
  uiDir: string;
  sse: SseHub;
  /** Collections running or queued, for /api/health. */
  collecting: () => number;
  log: Logger;
  /** The port the server listens on; read per request, so it may be set after listen. */
  port: () => number;
}

const isApiPath = (url: string): boolean => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

/** `127.0.0.1:<port>` or `localhost:<port>`, case-insensitive. */
function allowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return value === `127.0.0.1:${String(port)}` || value === `localhost:${String(port)}`;
}

function allowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${String(port)}` || origin === `http://localhost:${String(port)}`;
}

/** Whether the request carries a body: a content length above zero or a chunked transfer. */
function hasBody(request: FastifyRequest): boolean {
  const length = request.headers['content-length'];
  return (length !== undefined && length !== '0') || request.headers['transfer-encoding'] !== undefined;
}

/** Builds the server with its routes registered; the caller listens (or injects). */
export async function buildHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const uiAvailable = existsSync(join(options.uiDir, 'index.html'));

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = options.port();
    if (!allowedHost(request.headers.host, port)) {
      return sendError(reply, 421, 'misdirected-request', 'unexpected Host header');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // The write guard (ADR-017, ADR-028): the daemon's own page, same-origin, JSON.
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      if (!allowedOrigin(origin, port) || (site !== undefined && site !== 'same-origin')) {
        return sendError(reply, 403, 'cross-site', 'writes need the daemon Origin and no cross-site Fetch metadata');
      }
      if (hasBody(request) && !/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) {
        return sendError(reply, 415, 'unsupported-media-type', 'a request body must be Content-Type application/json');
      }
    }
    return undefined;
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) return sendError(reply, error.statusCode, error.code, error.message);
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, codeForStatus(statusCode), errorMessage(error));
    }
    options.log.error(`${request.method} ${request.url} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return sendError(reply, 500, 'internal', 'internal server error');
  });

  app.setNotFoundHandler(async (request, reply) => {
    const isPage = (request.method === 'GET' || request.method === 'HEAD') && !isApiPath(request.url);
    if (!isPage) return sendError(reply, 404, 'not-found', `no route for ${request.method} ${request.url.split('?')[0] ?? ''}`);
    if (!uiAvailable) return reply.status(503).type('text/html; charset=utf-8').send(UI_NOT_BUILT_HTML);
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });

  app.get('/api/health', (): HealthResponse => ({
    version: options.version,
    pid: options.pid,
    startedAt: options.startedAt,
    collecting: options.collecting(),
  }));

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    options.sse.attach(reply.raw);
    request.raw.once('close', () => {
      reply.raw.end();
    });
  });

  if (uiAvailable) {
    await app.register(fastifyStatic, { root: options.uiDir, prefix: '/', wildcard: true, index: 'index.html' });
  }

  return app;
}
