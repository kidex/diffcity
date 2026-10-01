// The socket protocol v1 (ADR-016): one JSON line each way per connection,
// 64 KiB per request, a 5 s timeout, mode 0600, a registry for track/register.

import { connect } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SocketRequest } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { parseRequest, MAX_REQUEST_BYTES, REQUEST_TIMEOUT_MS } from '../../../src/daemon/socket/protocol.js';
import { createSocketServer, RESPONSE_LINGER_MS, type SocketServer } from '../../../src/daemon/socket/server.js';
import { PassThrough } from 'node:stream';

let dir: string;
let server: SocketServer | undefined;
let shutdowns: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-sock-'));
  shutdowns = 0;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function start(options: { timeoutMs?: number; lingerMs?: number } = {}): Promise<string> {
  const path = join(dir, 'daemon.sock');
  server = createSocketServer({
    path,
    log: createStreamLogger(new PassThrough()),
    ping: () => ({ ok: true, version: '9.9.9', pid: 123, port: 4567 }),
    shutdown: () => {
      shutdowns++;
    },
    ...options,
  });
  await server.listen();
  return path;
}

/** Writes raw bytes and collects everything the server sends until it closes. */
function raw(path: string, payload: string | Buffer, { end = true } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The server may reset the connection after refusing an oversized request.
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(received);
      else reject(error);
    });
    socket.write(payload);
    if (end) socket.end();
  });
}

describe('parseRequest', () => {
  it('accepts every v1 request type', () => {
    const requests: SocketRequest[] = [
      { v: 1, type: 'ping' },
      { v: 1, type: 'shutdown' },
      { v: 1, type: 'track', dir: '/work/sample-shop', agent: true, at: '2026-01-01T00:00:00.000Z' },
      { v: 1, type: 'register', dirs: ['/work/sample-shop', '/work/order-service'] },
    ];
    for (const request of requests) expect(parseRequest(JSON.stringify(request))).toEqual({ ok: true, request });
  });

  it.each([
    ['not json', /invalid JSON/],
    ['[1]', /must be a JSON object/],
    ['{"type":"ping"}', /unsupported protocol version/],
    ['{"v":2,"type":"ping"}', /unsupported protocol version: 2/],
    ['{"v":1,"type":"launch"}', /unknown request type: launch/],
    ['{"v":1}', /unknown request type/],
    ['{"v":1,"type":"track","dir":"relative","agent":false,"at":"x"}', /dir must be an absolute path/],
    ['{"v":1,"type":"track","dir":"/a","agent":"yes","at":"x"}', /agent must be a boolean/],
    ['{"v":1,"type":"track","dir":"/a","agent":false}', /at must be a string/],
    ['{"v":1,"type":"register","dirs":["/a","b"]}', /dirs must be absolute paths/],
  ])('refuses %s', (line, error) => {
    const result = parseRequest(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });

  it('limits are 64 KiB and 5 s', () => {
    expect(MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
  });
});

describe('socket server', () => {
  it('creates the socket with mode 0600', async () => {
    const path = await start();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('answers ping', async () => {
    const path = await start();
    expect(await sendRequest(path, { v: 1, type: 'ping' })).toEqual({ ok: true, version: '9.9.9', pid: 123, port: 4567 });
  });

  it('socket/bad-json: an invalid line gets { ok: false } and the server keeps serving', async () => {
    const path = await start();
    const reply = JSON.parse(await raw(path, '{nope\n')) as unknown;
    expect(reply).toEqual({ ok: false, error: expect.stringMatching(/invalid JSON/) as unknown });
    expect(await sendRequest(path, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });

  it('socket/unknown-version: v: 2 gets { ok: false }', async () => {
    const path = await start();
    expect(JSON.parse(await raw(path, '{"v":2,"type":"ping"}\n'))).toEqual({
      ok: false,
      error: 'unsupported protocol version: 2',
    });
  });

  it('socket/oversized-request: more than 64 KiB is refused without waiting for a newline', async () => {
    const path = await start();
    const reply = await raw(path, Buffer.alloc(MAX_REQUEST_BYTES + 1, 'a'), { end: false });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: `request exceeds ${String(MAX_REQUEST_BYTES)} bytes` });
    expect(await sendRequest(path, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });

  it('accepts a request of exactly 64 KiB', async () => {
    const path = await start();
    const base = '{"v":1,"type":"ping","pad":""}';
    const line = base.replace('""', `"${'p'.repeat(MAX_REQUEST_BYTES - base.length)}"`);
    expect(Buffer.byteLength(line)).toBe(MAX_REQUEST_BYTES);
    expect(JSON.parse(await raw(path, `${line}\n`))).toMatchObject({ ok: true });
  });

  it('accepts a request ended by closing the connection instead of a newline', async () => {
    const path = await start();
    expect(JSON.parse(await raw(path, '{"v":1,"type":"ping"}'))).toMatchObject({ ok: true });
  });

  it('closes a connection that sends no complete request within the timeout', async () => {
    const path = await start({ timeoutMs: 100 });
    const started = Date.now();
    const reply = await raw(path, '{"v":1,', { end: false });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'request timed out' });
  });

  it('track and register answer with an explicit error until a handler is registered', async () => {
    const path = await start();
    expect(await sendRequest(path, { v: 1, type: 'track', dir: '/work/sample-shop', agent: false, at: 'now' })).toEqual({
      ok: false,
      error: 'track is not supported by this daemon yet',
    });
    expect(await sendRequest(path, { v: 1, type: 'register', dirs: [] })).toEqual({
      ok: false,
      error: 'register is not supported by this daemon yet',
    });
  });

  it('routes track and register to registered handlers', async () => {
    const path = await start();
    server?.handlers.handle('track', (request) => ({ ok: true, repo: { id: 7, name: request.dir.split('/').at(-1) ?? '' } }));
    server?.handlers.handle('register', async (request) => {
      await Promise.resolve();
      return { ok: true, registered: request.dirs.length, known: 0 };
    });
    expect(await sendRequest(path, { v: 1, type: 'track', dir: '/work/sample-shop', agent: true, at: 'now' })).toEqual({
      ok: true,
      repo: { id: 7, name: 'sample-shop' },
    });
    expect(await sendRequest(path, { v: 1, type: 'register', dirs: ['/a', '/b'] })).toEqual({
      ok: true,
      registered: 2,
      known: 0,
    });
  });

  it('refuses a second handler for the same type', async () => {
    await start();
    server?.handlers.handle('track', () => ({ ok: false, error: 'x' }));
    expect(() => server?.handlers.handle('track', () => ({ ok: false, error: 'y' }))).toThrow(/already has a handler/);
  });

  it('turns a throwing handler into { ok: false } and keeps serving', async () => {
    const path = await start();
    server?.handlers.handle('track', () => {
      throw new Error('repo exploded');
    });
    expect(await sendRequest(path, { v: 1, type: 'track', dir: '/a', agent: false, at: 'now' })).toEqual({
      ok: false,
      error: 'repo exploded',
    });
    expect(await sendRequest(path, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });

  it('answers shutdown before calling the shutdown hook', async () => {
    const path = await start();
    expect(await sendRequest(path, { v: 1, type: 'shutdown' })).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdowns).toBe(1);
  });

  it('close() leaves a socket file that another server bound at the same path', async () => {
    const path = await start();
    const { rm: remove } = await import('node:fs/promises');
    const { createServer } = await import('node:net');
    await remove(path);
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(path, resolve));
    try {
      await server?.close();
      server = undefined;
      expect((await stat(path)).isSocket()).toBe(true);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });

  it('bound() reports the device and inode of the socket file', async () => {
    const path = await start();
    const info = await stat(path);
    expect(server?.bound()).toEqual({ path, dev: info.dev, ino: info.ino });
  });

  it('replaces a stale socket file left by a dead daemon', async () => {
    const path = join(dir, 'daemon.sock');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '');
    await start();
    expect(await sendRequest(path, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });
});

describe('sendRequest', () => {
  it('rejects with ENOENT when nothing listens', async () => {
    await expect(sendRequest(join(dir, 'missing.sock'), { v: 1, type: 'ping' })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('socket server, half-open clients', () => {
  /**
   * A client that keeps its side open after the response, then writes once
   * 300 ms later: the write fails (EPIPE/ECONNRESET) only if the server has
   * destroyed the connection by then.
   */
  async function writeAfterResponse(path: string): Promise<{ received: string; writeError: string | null }> {
    return new Promise((resolve) => {
      const socket = connect({ path, allowHalfOpen: true });
      let text = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (text += chunk));
      socket.on('error', (error: NodeJS.ErrnoException) => {
        resolve({ received: text, writeError: error.code ?? 'error' });
      });
      socket.on('end', () => {
        setTimeout(() => {
          socket.write('late\n');
          setTimeout(() => {
            socket.destroy();
            resolve({ received: text, writeError: null });
          }, 300);
        }, 300);
      });
      socket.write('{"v":1,"type":"ping"}\n');
    });
  }

  it('destroys a connection whose client never closes its side after the response', async () => {
    const path = await start({ lingerMs: 50 });
    const { received, writeError } = await writeAfterResponse(path);
    expect(JSON.parse(received)).toMatchObject({ ok: true });
    expect(writeError).toMatch(/^(EPIPE|ECONNRESET)$/);
  });

  it('keeps a half-open connection until the linger ends', async () => {
    const path = await start({ lingerMs: 5000 });
    const { writeError } = await writeAfterResponse(path);
    expect(writeError).toBeNull();
  });

  it('lingers 2 s by default', () => {
    expect(RESPONSE_LINGER_MS).toBe(2000);
  });
});

describe('socket server, slow handlers', () => {
  it('a client that ends right after its line still gets the handler response', async () => {
    const path = await start();
    server?.handlers.handle('register', async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true, registered: request.dirs.length, known: 1 };
    });
    expect(JSON.parse(await raw(path, '{"v":1,"type":"register","dirs":["/a"]}\n'))).toEqual({
      ok: true,
      registered: 1,
      known: 1,
    });
  });
});
