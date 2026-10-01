// The SSE hub (ADR-017): `retry: 2000`, `hello` on connect, a `: ping` comment
// every 15 s, small signal events broadcast to every client.

import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSseHub, SSE_PING_MS, SSE_RETRY_MS } from '../../../src/daemon/sse.js';

const hello = { version: '9.9.9', startedAt: '2026-01-01T00:00:00.000Z' };

function client(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (text += chunk));
  return { stream, text: () => text };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sse/hello-and-ping', () => {
  it('constants: ping every 15 s, retry 2000 ms', () => {
    expect(SSE_PING_MS).toBe(15_000);
    expect(SSE_RETRY_MS).toBe(2000);
  });

  it('sends retry and hello on connect, then a ping comment every 15 s', async () => {
    const hub = createSseHub({ hello: () => hello });
    const { stream, text } = client();
    hub.attach(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(text()).toBe(`retry: 2000\n\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(text()).not.toContain(': ping');
    await vi.advanceTimersByTimeAsync(1);
    expect(text().match(/^: ping\n\n/gm)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text().match(/^: ping\n\n/gm)).toHaveLength(2);
    hub.close();
  });

  it('broadcasts events to every client and forgets closed ones', async () => {
    const hub = createSseHub({ hello: () => hello });
    const a = client();
    const b = client();
    hub.attach(a.stream);
    hub.attach(b.stream);
    expect(hub.size).toBe(2);
    hub.broadcast({ event: 'repo', data: { repoId: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    for (const c of [a, b]) expect(c.text()).toContain('event: repo\ndata: {"repoId":3}\n\n');

    b.stream.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.size).toBe(1);
    hub.broadcast({ event: 'changes', data: { repoId: 3 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(a.text()).toContain('event: changes');
    hub.close();
  });

  it('close() ends every stream and stops the pings', async () => {
    const hub = createSseHub({ hello: () => hello });
    const { stream } = client();
    const ended = new Promise((resolve) => stream.on('finish', resolve));
    hub.attach(stream);
    hub.close();
    await vi.advanceTimersByTimeAsync(0);
    await ended;
    expect(hub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
