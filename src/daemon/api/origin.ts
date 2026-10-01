// Whether a request comes from the daemon's own UI, for the one GET that writes
// (`lastSeenAt` on GET /api/repos/:id). A page on any other site can make the
// browser send a GET to 127.0.0.1 (an <img> tag, say); such a request is still
// answered but must not mark a repo as seen, or it would make it active
// (ADR-020). Requests without browser headers (curl, tests) count as own.

import type { FastifyRequest } from 'fastify';

function ownOrigins(port: number): string[] {
  return [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** False for a cross-site browser request: Sec-Fetch-Site, Origin or Referer pointing elsewhere. */
export function isSameOrigin(request: FastifyRequest, port: number): boolean {
  const own = ownOrigins(port);
  const site = header(request, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = header(request, 'origin');
  if (origin !== undefined && !own.includes(origin.toLowerCase())) return false;
  const referer = header(request, 'referer');
  if (referer !== undefined) {
    const refererOrigin = originOf(referer);
    if (refererOrigin === null || !own.includes(refererOrigin)) return false;
  }
  return true;
}
