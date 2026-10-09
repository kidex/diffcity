// The socket protocol v1 (ADR-016): one JSON line each way per connection,
// 64 KiB per request, a 5 s timeout, mode 0600, a registry for track/register.
// `import` (ADR-036): up to 4 MiB for a line that starts as an import, 30 s.

import { connect } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SocketRequest } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import {
  IMPORT_REQUEST_TIMEOUT_MS,
  MAX_IMPORT_REQUEST_BYTES,
  maxBytesFor,
  parseRequest,
  MAX_REQUEST_BYTES,
  REQUEST_TIMEOUT_MS,
  startsAsImport,
} from '../../../src/daemon/socket/protocol.js';
import { createSocketServer, RESPONSE_LINGER_MS, sweepTempSockets, type SocketServer } from '../../../src/daemon/socket/server.js';
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

async function start(options: { timeoutMs?: number; lingerMs?: number; importTimeoutMs?: number; importMaxBytes?: number } = {}): Promise<string> {
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
      {
        v: 1,
        type: 'track',
        dir: '/work/sample-shop',
        agent: true,
        at: '2026-01-01T00:00:00.000Z',
        session: { sessionId: 'deadbeef-0001', transcriptPath: '/claude/projects/p/deadbeef-0001.jsonl', cwd: '/work/sample-shop', event: 'Stop' },
      },
      { v: 1, type: 'sessions', dir: '/work/sample-shop' },
      { v: 1, type: 'register', dirs: ['/work/sample-shop', '/work/order-service'] },
      { v: 1, type: 'import', dir: '/work/sample-shop', findings: [IMPORTED], warnings: [{ at: 'findings[1]', message: 'skipped: empty path' }], sources: ['claude'], at: '2026-01-01T00:00:00.000Z' },
    ];
    for (const request of requests) expect(parseRequest(JSON.stringify(request))).toEqual({ ok: true, request });
  });

  it('a track session that is not four strings is dropped; the track itself stands, extra session fields go', () => {
    const base = { v: 1, type: 'track', dir: '/work/sample-shop', agent: true, at: '2026-01-01T00:00:00.000Z' };
    const plain = { ok: true, request: base };
    expect(parseRequest(JSON.stringify({ ...base, session: 'deadbeef-0001' }))).toEqual(plain);
    expect(parseRequest(JSON.stringify({ ...base, session: { sessionId: 'deadbeef-0001', transcriptPath: 7, cwd: '/a', event: 'Stop' } }))).toEqual(plain);
    expect(parseRequest(JSON.stringify({ ...base, session: null }))).toEqual(plain);
    const session = { sessionId: 'deadbeef-0001', transcriptPath: '/claude/projects/p/deadbeef-0001.jsonl', cwd: '/a', event: 'Stop' };
    expect(parseRequest(JSON.stringify({ ...base, session: { ...session, subagentsDir: '/elsewhere' } }))).toEqual({ ok: true, request: { ...base, session } });
  });

  it('socket/track-old-daemon-ignores-session: a v1 track line with fields the parser does not know is accepted with the known ones', () => {
    // A daemon from before ADR-038 knows dir, agent and at; `session` is one more unknown field to it,
    // like `future` is to this one: the request is served, the field ignored.
    const line = JSON.stringify({
      v: 1,
      type: 'track',
      dir: '/work/sample-shop',
      agent: true,
      at: '2026-01-01T00:00:00.000Z',
      session: { sessionId: 'deadbeef-0001', transcriptPath: '/claude/projects/p/deadbeef-0001.jsonl', cwd: '/work/sample-shop', event: 'Stop' },
      future: { anything: [1, 2] },
    });
    const parsed = parseRequest(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request).not.toHaveProperty('future');
    const request = parsed.request as Extract<SocketRequest, { type: 'track' }>;
    expect([request.v, request.type, request.dir, request.agent, request.at]).toEqual([1, 'track', '/work/sample-shop', true, '2026-01-01T00:00:00.000Z']);
  });

  it.each([
    ['not json', /invalid JSON/],
    ['{"v":1,"type":"sessions","dir":"relative"}', /invalid sessions request: dir must be an absolute path/],
    ['[1]', /must be a JSON object/],
    ['{"type":"ping"}', /unsupported protocol version/],
    ['{"v":2,"type":"ping"}', /unsupported protocol version: 2/],
    ['{"v":1,"type":"launch"}', /unknown request type: launch/],
    ['{"v":1}', /unknown request type/],
    ['{"v":1,"type":"track","dir":"relative","agent":false,"at":"x"}', /dir must be an absolute path/],
    ['{"v":1,"type":"track","dir":"/a","agent":"yes","at":"x"}', /agent must be a boolean/],
    ['{"v":1,"type":"track","dir":"/a","agent":false}', /at must be a string/],
    ['{"v":1,"type":"register","dirs":["/a","b"]}', /dirs must be absolute paths/],
    ['{"v":1,"type":"import","dir":"relative","findings":[],"warnings":[],"at":"x"}', /invalid import request: dir must be an absolute path/],
    ['{"v":1,"type":"import","dir":"/a","findings":[],"warnings":[]}', /invalid import request: at must be a string/],
    ['{"v":1,"type":"import","dir":"/a","findings":{},"warnings":[],"at":"x"}', /invalid import request: findings must be an array/],
    ['{"v":1,"type":"import","dir":"/a","findings":[{"source":"claude"}],"warnings":[],"at":"x"}', /invalid import request: findings\[0\]/],
  ])('refuses %s', (line, error) => {
    const result = parseRequest(line);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(error);
  });

  it('limits are 64 KiB and 5 s; an import has 4 MiB and 30 s', () => {
    expect(MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(REQUEST_TIMEOUT_MS).toBe(5000);
    expect(MAX_IMPORT_REQUEST_BYTES).toBe(4 * 1024 * 1024);
    expect(IMPORT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(maxBytesFor('import')).toBe(MAX_IMPORT_REQUEST_BYTES);
    expect(maxBytesFor('track')).toBe(MAX_REQUEST_BYTES);
  });

  it('recognises the start of an import line, as the CLI writes it or with whitespace', () => {
    expect(startsAsImport(JSON.stringify({ v: 1, type: 'import', dir: '/a' }))).toBe(true);
    expect(startsAsImport('{ "v" : 1 ,\n "type": "import", ')).toBe(true);
    expect(startsAsImport('{"type":"import","v":1,')).toBe(false);
    expect(startsAsImport('{"v":1,"type":"importer",')).toBe(false);
    expect(startsAsImport('{"v":1,"type":"track",')).toBe(false);
  });
});

const IMPORTED = {
  source: 'claude',
  severity: 'high' as const,
  category: 'security' as const,
  file: 'src/auth/order.guard.ts',
  line: 14,
  title: 'Optional order defaults to allow',
  message: 'When order is undefined the guard returns true.',
};

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

  it('import answers with an explicit error until a handler is registered, then routes to it', async () => {
    const path = await start();
    const request = { v: 1 as const, type: 'import' as const, dir: '/work/sample-shop', findings: [IMPORTED], warnings: [], sources: ['claude'], at: 'now' };
    expect(await sendRequest(path, request)).toEqual({ ok: false, error: 'import is not supported by this daemon yet' });
    server?.handlers.handle('import', (received) => ({
      ok: true,
      change: { id: 3, repoId: 1, ref: 'branch:feature/cancel' },
      imported: received.findings.length,
      merged: 0,
      skipped: 0,
      fixed: 0,
      warnings: [],
      anchoredAgainst: 'current-snapshot',
    }));
    expect(await sendRequest(path, request)).toMatchObject({ ok: true, imported: 1 });
  });

  it('sessions answers with an explicit error until a handler is registered, then routes to it', async () => {
    const path = await start();
    const request = { v: 1 as const, type: 'sessions' as const, dir: '/work/sample-shop' };
    expect(await sendRequest(path, request)).toEqual({ ok: false, error: 'sessions is not supported by this daemon yet' });
    server?.handlers.handle('sessions', () => ({ ok: true, change: { id: 3, repoId: 1, ref: 'branch:feature/cancel' }, sessions: [], total: 0 }));
    expect(await sendRequest(path, request)).toEqual({ ok: true, change: { id: 3, repoId: 1, ref: 'branch:feature/cancel' }, sessions: [], total: 0 });
  });

  it('an import line may pass 64 KiB up to the import cap; past it, it is refused at once', async () => {
    const path = await start({ importMaxBytes: 256 * 1024 });
    server?.handlers.handle('import', (received) => ({ ok: false, error: `got ${String(received.findings.length)}` }));
    const findings = Array.from({ length: 600 }, (_, index) => ({ ...IMPORTED, title: `Finding ${String(index)}` }));
    const line = JSON.stringify({ v: 1, type: 'import', dir: '/work/sample-shop', findings, warnings: [], at: 'now' });
    expect(Buffer.byteLength(line)).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(Buffer.byteLength(line)).toBeLessThan(256 * 1024);
    expect(JSON.parse(await raw(path, `${line}\n`))).toEqual({ ok: false, error: 'got 600' });
    const oversized = await raw(path, Buffer.concat([Buffer.from('{"v":1,"type":"import",'), Buffer.alloc(256 * 1024, 'a')]), { end: false });
    expect(JSON.parse(oversized)).toEqual({ ok: false, error: `request exceeds ${String(256 * 1024)} bytes` });
  });

  it('a line read under the import cap whose last type key is not import is refused at 64 KiB', async () => {
    const path = await start();
    server?.handlers.handle('track', () => ({ ok: true, repo: { id: 1, name: 'x' } }));
    const line = `{"v":1,"type":"import","pad":"${'p'.repeat(MAX_REQUEST_BYTES)}","type":"track","dir":"/a","agent":false,"at":"now"}`;
    expect(JSON.parse(await raw(path, `${line}\n`))).toEqual({ ok: false, error: `request exceeds ${String(MAX_REQUEST_BYTES)} bytes` });
  });

  it('an import exchange gets the import timeout instead of the default one', async () => {
    const path = await start({ timeoutMs: 50, importTimeoutMs: 400 });
    // Answers after 200 ms: past the default timeout, within the import one.
    server?.handlers.handle('import', () => new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ok: false, error: 'released' });
      }, 200);
    }));
    const request = { v: 1, type: 'import', dir: '/work/sample-shop', findings: [], warnings: [], at: 'now' };
    expect(JSON.parse(await raw(path, `${JSON.stringify(request)}\n`))).toEqual({ ok: false, error: 'released' });
    server?.handlers.handle('track', () => new Promise(() => undefined));
    const track = { v: 1, type: 'track', dir: '/a', agent: false, at: 'now' };
    expect(JSON.parse(await raw(path, `${JSON.stringify(track)}\n`))).toEqual({ ok: false, error: 'request timed out' });
  });

  it('a large import line still arriving after the default timeout is given the import budget', async () => {
    const path = await start({ timeoutMs: 100, importTimeoutMs: 5000 });
    server?.handlers.handle('import', () => ({ ok: false, error: 'arrived' }));
    const line = `${JSON.stringify({ v: 1, type: 'import', dir: '/work/sample-shop', findings: [], warnings: [], pad: 'p'.repeat(MAX_REQUEST_BYTES), at: 'now' })}\n`;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(path);
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (received += chunk));
      socket.on('close', () => {
        resolve(received);
      });
      socket.on('error', reject);
      socket.write(line.slice(0, MAX_REQUEST_BYTES + 100));
      setTimeout(() => socket.end(line.slice(MAX_REQUEST_BYTES + 100)), 400);
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: 'arrived' });
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

describe('sweepTempSockets', () => {
  /** A socket file named `name` that nobody listens on, as a daemon SIGKILLed before its rename leaves. */
  async function deadSocket(name: string): Promise<string> {
    const { createServer } = await import('node:net');
    const { rename } = await import('node:fs/promises');
    const bindPath = join(dir, 'bind.tmp');
    const target = join(dir, name);
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(bindPath, resolve));
    await rename(bindPath, target);
    // close() unlinks bind.tmp, which is gone: the renamed socket stays, with no listener.
    await new Promise((resolve) => other.close(resolve));
    return target;
  }

  it('removes .dc temp sockets nobody listens on and keeps live ones and other files', async () => {
    const { createServer } = await import('node:net');
    const { writeFile } = await import('node:fs/promises');
    const dead = await deadSocket('.dcaaaaaa');
    expect((await stat(dead)).isSocket()).toBe(true);
    const live = join(dir, '.dcbbbbbb');
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(live, resolve));
    const regular = join(dir, '.dccccccc');
    await writeFile(regular, 'not a socket');
    const unrelated = await deadSocket('other.sock');
    try {
      await sweepTempSockets(dir);
      await expect(stat(dead)).rejects.toThrow(/ENOENT/);
      expect((await stat(live)).isSocket()).toBe(true);
      expect((await stat(regular)).isFile()).toBe(true);
      expect((await stat(unrelated)).isSocket()).toBe(true);
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });

  it('listen() sweeps leftovers in the socket directory', async () => {
    const dead = await deadSocket('.dcdddddd');
    await start();
    await expect(stat(dead)).rejects.toThrow(/ENOENT/);
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
