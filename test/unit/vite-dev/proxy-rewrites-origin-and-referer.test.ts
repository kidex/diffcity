// vite-dev/proxy-rewrites-origin-and-referer (DC-66): through the Vite dev
// server, the daemon must see the dev page's /api requests as its own, while
// any other origin still reaches it as cross-site.

import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { rewriteOriginToDaemon } from '../../../vite.config.js';

const DAEMON = 'http://127.0.0.1:4321';

/** Runs the hook on one proxied request and returns the headers sent to the daemon. */
function proxied(headers: IncomingHttpHeaders, target = DAEMON): Record<string, string> {
  const proxy = new EventEmitter();
  const configure = rewriteOriginToDaemon(target);
  configure(proxy as never, {});
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (typeof value === 'string') sent[name] = value;
  const proxyReq = {
    setHeader(name: string, value: string) {
      sent[name.toLowerCase()] = value;
    },
  };
  proxy.emit('proxyReq', proxyReq, { headers }, {}, {});
  return sent;
}

describe('vite-dev/proxy-rewrites-origin-and-referer', () => {
  it('rewrites the dev page Origin and Referer to the daemon origin, keeping the Referer path', () => {
    const sent = proxied({
      host: '127.0.0.1:5173',
      origin: 'http://127.0.0.1:5173',
      referer: 'http://127.0.0.1:5173/?x=1#/repo/3',
    });
    expect(sent.origin).toBe(DAEMON);
    expect(sent.referer).toBe(`${DAEMON}/?x=1#/repo/3`);
  });

  it('rewrites a Referer alone, the way a same-origin GET sends it', () => {
    const sent = proxied({ host: 'localhost:5173', referer: 'http://localhost:5173/' });
    expect(sent.referer).toBe(`${DAEMON}/`);
    expect(sent.origin).toBeUndefined();
  });

  it('leaves another site untouched, so the daemon still sees it as cross-site', () => {
    const sent = proxied({
      host: '127.0.0.1:5173',
      origin: 'https://elsewhere.example',
      referer: 'https://elsewhere.example/page',
    });
    expect(sent.origin).toBe('https://elsewhere.example');
    expect(sent.referer).toBe('https://elsewhere.example/page');
  });

  it('adds no header the browser did not send', () => {
    expect(proxied({ host: '127.0.0.1:5173' })).toEqual({ host: '127.0.0.1:5173' });
  });

  it('uses the configured daemon origin, not a fixed port', () => {
    const sent = proxied({ host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }, 'http://127.0.0.1:4400/');
    expect(sent.origin).toBe('http://127.0.0.1:4400');
  });
});
