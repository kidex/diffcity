// The SSE hub behind GET /api/events (ADR-017). Events are small signals; the
// UI refetches over REST, so a lost event never leaves it inconsistent and
// there is no Last-Event-ID replay.

import type { SseEvent, SseEventOf } from '../core/model/types.js';

/** A `: ping` comment is sent to each client this often. */
export const SSE_PING_MS = 15_000;

/** The reconnection delay advertised to the browser. */
export const SSE_RETRY_MS = 2000;

/** The part of a response the hub writes to; an http.ServerResponse in the daemon. */
export interface SseStream {
  write(chunk: string): boolean;
  end(): void;
  once(event: 'close', listener: () => void): unknown;
}

export interface SseHub {
  /** Sends `retry` and `hello`, then keeps the stream until it closes. */
  attach(stream: SseStream): void;
  /** Sends the event to every connected client. */
  broadcast(event: SseEvent): void;
  /** Ends every stream; later attaches are ended at once. */
  close(): void;
  /** Connected clients. */
  readonly size: number;
}

export interface SseHubOptions {
  hello: () => SseEventOf<'hello'>['data'];
  pingMs?: number;
}

export function formatSseEvent(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function createSseHub(options: SseHubOptions): SseHub {
  const pingMs = options.pingMs ?? SSE_PING_MS;
  const clients = new Map<SseStream, NodeJS.Timeout>();
  let closed = false;

  const drop = (stream: SseStream): void => {
    const timer = clients.get(stream);
    if (timer === undefined) return;
    clearInterval(timer);
    clients.delete(stream);
  };

  return {
    attach(stream) {
      if (closed) {
        stream.end();
        return;
      }
      stream.write(`retry: ${String(SSE_RETRY_MS)}\n\n`);
      stream.write(formatSseEvent({ event: 'hello', data: options.hello() }));
      const timer = setInterval(() => {
        stream.write(': ping\n\n');
      }, pingMs);
      timer.unref();
      clients.set(stream, timer);
      stream.once('close', () => {
        drop(stream);
      });
    },
    broadcast(event) {
      const text = formatSseEvent(event);
      for (const stream of clients.keys()) stream.write(text);
    },
    close() {
      closed = true;
      for (const stream of [...clients.keys()]) {
        drop(stream);
        stream.end();
      }
    },
    get size() {
      return clients.size;
    },
  };
}
