// The daemon's socket server (ADR-016). `ping` and `shutdown` are built in;
// `track`, `register` and `import` go through a handler registry that the
// collection fills, and answer with an explicit error until then. A line is
// read up to 64 KiB, or up to 4 MiB when it starts as an `import` request,
// whose exchange may also take 30 s instead of 5 (ADR-036, protocol.ts).

import { randomBytes } from 'node:crypto';
import { chmod, lstat, readdir, rename, rm } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { SocketRequest, SocketResponse, SocketResponseFor, SocketSuccessResponses } from '../../core/model/types.js';
import { fileIdentity, type BoundFile } from '../files.js';
import { errorMessage, type Logger } from '../log.js';
import {
  IMPORT_REQUEST_TIMEOUT_MS,
  IMPORT_START_PEEK_BYTES,
  MAX_IMPORT_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
  parseRequest,
  REQUEST_TIMEOUT_MS,
  startsAsImport,
} from './protocol.js';

/** Request types served by a registered handler rather than by the socket server itself. */
export type PluggableRequestType = 'track' | 'register' | 'import';

export type SocketRequestOf<T extends SocketRequest['type']> = Extract<SocketRequest, { type: T }>;

/** Handles one request; a thrown error becomes `{ ok: false, error: <message> }`. */
export type SocketHandler<T extends PluggableRequestType> = (
  request: SocketRequestOf<T>,
) => SocketResponseFor<T> | Promise<SocketResponseFor<T>>;

export interface SocketHandlerRegistry {
  /** Registers the handler for `type`; throws if one is already registered. */
  handle<T extends PluggableRequestType>(type: T, handler: SocketHandler<T>): void;
}

export interface SocketServerOptions {
  path: string;
  log: Logger;
  /** The `ping` response. */
  ping: () => SocketSuccessResponses['ping'];
  /** Called once the `shutdown` response has been flushed. */
  shutdown: () => void;
  timeoutMs?: number;
  maxBytes?: number;
  /** Defaults to IMPORT_REQUEST_TIMEOUT_MS. */
  importTimeoutMs?: number;
  /** Defaults to MAX_IMPORT_REQUEST_BYTES. */
  importMaxBytes?: number;
  /** Defaults to RESPONSE_LINGER_MS. */
  lingerMs?: number;
}

/**
 * After the response, a client that keeps its side open is cut off this long
 * after the server's end(), so half-open connections do not pile up.
 */
export const RESPONSE_LINGER_MS = 2000;

export interface SocketServer {
  readonly handlers: SocketHandlerRegistry;
  /** Listens with mode 0600, replacing any leftover file at the path. */
  listen(): Promise<void>;
  /** Stops accepting connections, ends open ones and removes nothing (the daemon removes the file). */
  close(): Promise<void>;
  /** The socket file this server bound (device and inode), or null before listen. */
  bound(): BoundFile | null;
}

/** The temporary names listen() binds before renaming into place. */
const TEMP_SOCKET_NAME = /^\.dc[0-9a-f]{6}$/;

/** True when something accepts connections on the socket at `path`. */
function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      resolve(false);
    });
  });
}

/**
 * Removes temporary socket names (`.dcXXXXXX`) in `dir` that nobody listens
 * on: a daemon killed between its listen and its rename leaves one behind.
 * A name some server still listens on (a daemon starting right now, maybe
 * another home's in a shared temporary directory) is left alone.
 */
export async function sweepTempSockets(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => []);
  for (const name of names) {
    if (!TEMP_SOCKET_NAME.test(name)) continue;
    const path = join(dir, name);
    const isSocket = await lstat(path).then(
      (info) => info.isSocket(),
      () => false,
    );
    if (isSocket && !(await isListening(path))) await rm(path, { force: true });
  }
}

type HandlerMap = { [T in PluggableRequestType]?: SocketHandler<T> };

const notSupported = (type: PluggableRequestType): SocketResponse => ({
  ok: false,
  error: `${type} is not supported by this daemon yet`,
});

export function createSocketServer(options: SocketServerOptions): SocketServer {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_REQUEST_BYTES;
  const importMaxBytes = options.importMaxBytes ?? MAX_IMPORT_REQUEST_BYTES;
  const importTimeoutMs = options.importTimeoutMs ?? IMPORT_REQUEST_TIMEOUT_MS;
  const lingerMs = options.lingerMs ?? RESPONSE_LINGER_MS;
  const handlerMap: HandlerMap = {};
  const connections = new Set<Socket>();

  const handlers: SocketHandlerRegistry = {
    handle(type, handler) {
      if (handlerMap[type] !== undefined) throw new Error(`socket request type ${type} already has a handler`);
      // The mapped type cannot be indexed by a generic key without a cast; `handler` matches `type` by signature.
      (handlerMap as Record<PluggableRequestType, unknown>)[type] = handler;
    },
  };

  async function dispatch(request: SocketRequest): Promise<SocketResponse> {
    switch (request.type) {
      case 'ping':
        return options.ping();
      case 'shutdown':
        return { ok: true };
      case 'track':
        return handlerMap.track ? await handlerMap.track(request) : notSupported('track');
      case 'register':
        return handlerMap.register ? await handlerMap.register(request) : notSupported('register');
      case 'import':
        return handlerMap.import ? await handlerMap.import(request) : notSupported('import');
    }
  }

  function serve(socket: Socket): void {
    connections.add(socket);
    const connectedAt = Date.now();
    /** The line so far, in chunks: a 4 MiB import is not copied again on every chunk. */
    const chunks: Buffer[] = [];
    let length = 0;
    /** The cap of this line: MAX_REQUEST_BYTES until it is seen to start as an import. */
    let cap = maxBytes;
    let answered = false;
    let received = false;
    let linger: NodeJS.Timeout | undefined;

    const respond = (response: SocketResponse, after?: () => void): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(response)}\n`, after);
      linger = setTimeout(() => {
        socket.destroy();
      }, lingerMs);
      linger.unref();
    };

    const timedOut = (): void => {
      respond({ ok: false, error: 'request timed out' });
    };
    let timer = setTimeout(timedOut, timeoutMs);

    const handleLine = (bytes: Buffer): void => {
      received = true;
      const parsed = parseRequest(bytes.toString('utf8'));
      if (!parsed.ok) {
        respond({ ok: false, error: parsed.error });
        return;
      }
      const { request } = parsed;
      // A line read under the import cap whose last `type` key says otherwise.
      if (request.type !== 'import' && bytes.length > maxBytes) {
        respond({ ok: false, error: `request exceeds ${String(maxBytes)} bytes` });
        return;
      }
      if (request.type === 'import') {
        // The import's own budget, from the start of the connection.
        clearTimeout(timer);
        timer = setTimeout(timedOut, Math.max(0, importTimeoutMs - (Date.now() - connectedAt)));
      }
      dispatch(request).then(
        (response) => {
          respond(response, request.type === 'shutdown' ? options.shutdown : undefined);
        },
        (error: unknown) => {
          options.log.error(`socket ${request.type} failed: ${errorMessage(error)}`);
          respond({ ok: false, error: errorMessage(error) });
        },
      );
    };

    socket.on('data', (chunk: Buffer) => {
      if (answered || received) return;
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      chunks.push(part);
      length += part.length;
      if (length > cap && cap === maxBytes) {
        const head = Buffer.concat(chunks).subarray(0, IMPORT_START_PEEK_BYTES).toString('utf8');
        if (startsAsImport(head)) cap = Math.max(maxBytes, importMaxBytes);
      }
      if (length > cap) {
        respond({ ok: false, error: `request exceeds ${String(cap)} bytes` });
        return;
      }
      if (newline !== -1) {
        handleLine(Buffer.concat(chunks, length));
        chunks.length = 0;
        // Anything after the first line is ignored: one request per connection.
        socket.removeAllListeners('data');
        socket.resume();
      }
    });
    socket.on('end', () => {
      if (answered || received) return;
      if (length > 0) handleLine(Buffer.concat(chunks, length));
      else respond({ ok: false, error: 'empty request' });
    });
    socket.on('error', () => {
      // A client that goes away mid-exchange is not the daemon's problem.
    });
    socket.on('close', () => {
      clearTimeout(timer);
      clearTimeout(linger);
      connections.delete(socket);
    });
  }

  let server: Server | null = null;
  let boundFile: BoundFile | null = null;

  return {
    handlers,
    bound: () => boundFile,
    async listen() {
      // libuv unlinks a Unix socket by path when the server closes, whatever
      // file is there by then. So the server binds a short temporary name in
      // the same directory and the file is renamed into place: close() only
      // ever unlinks the temporary name, and the rename atomically replaces a
      // socket left by a dead daemon. The name is shorter than daemon.sock, so
      // it fits the socket path limit whenever the final path does.
      // The daemon holds the lock by now, so leftovers of a killed start can go.
      await sweepTempSockets(dirname(options.path));
      const temp = join(dirname(options.path), `.dc${randomBytes(3).toString('hex')}`);
      await rm(temp, { force: true });
      // Half-open, so a client that ends its side right after the request still gets the response.
      const created = createServer({ allowHalfOpen: true }, serve);
      server = created;
      let previousMask: number | null;
      try {
        // The socket is created with mode 0600 from the start; chmod below covers
        // threads, where process.umask() cannot change the mask.
        previousMask = process.umask(0o177);
      } catch {
        previousMask = null;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          created.once('error', reject);
          created.listen(temp, () => {
            created.off('error', reject);
            resolve();
          });
        });
      } finally {
        if (previousMask !== null) process.umask(previousMask);
      }
      await chmod(temp, 0o600);
      const identity = await fileIdentity(temp);
      await rename(temp, options.path);
      boundFile = identity === null ? null : { ...identity, path: options.path };
    },
    async close() {
      const current = server;
      server = null;
      if (current === null) return;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => {
        current.close(() => {
          resolve();
        });
      });
    },
  };
}
