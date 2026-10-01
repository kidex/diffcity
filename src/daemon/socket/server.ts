// The daemon's socket server (ADR-016). `ping` and `shutdown` are built in;
// `track` and `register` go through a handler registry that the collection
// (DC-29) fills, and answer with an explicit error until then.

import { randomBytes } from 'node:crypto';
import { chmod, rename, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { SocketRequest, SocketResponse, SocketResponseFor, SocketSuccessResponses } from '../../core/model/types.js';
import { fileIdentity, type BoundFile } from '../files.js';
import { errorMessage, type Logger } from '../log.js';
import { MAX_REQUEST_BYTES, parseRequest, REQUEST_TIMEOUT_MS } from './protocol.js';

/** Request types served by a registered handler rather than by the socket server itself. */
export type PluggableRequestType = 'track' | 'register';

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
}

export interface SocketServer {
  readonly handlers: SocketHandlerRegistry;
  /** Listens with mode 0600, replacing any leftover file at the path. */
  listen(): Promise<void>;
  /** Stops accepting connections, ends open ones and removes nothing (the daemon removes the file). */
  close(): Promise<void>;
  /** The socket file this server bound (device and inode), or null before listen. */
  bound(): BoundFile | null;
}

type HandlerMap = { [T in PluggableRequestType]?: SocketHandler<T> };

const notSupported = (type: PluggableRequestType): SocketResponse => ({
  ok: false,
  error: `${type} is not supported by this daemon yet`,
});

export function createSocketServer(options: SocketServerOptions): SocketServer {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_REQUEST_BYTES;
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
    }
  }

  function serve(socket: Socket): void {
    connections.add(socket);
    let buffered = Buffer.alloc(0);
    let answered = false;
    let received = false;

    const respond = (response: SocketResponse, after?: () => void): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(response)}\n`, after);
    };

    const timer = setTimeout(() => {
      respond({ ok: false, error: 'request timed out' });
    }, timeoutMs);

    const handleLine = (line: string): void => {
      received = true;
      const parsed = parseRequest(line);
      if (!parsed.ok) {
        respond({ ok: false, error: parsed.error });
        return;
      }
      const { request } = parsed;
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
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      const lineLength = newline === -1 ? buffered.length : newline;
      if (lineLength > maxBytes) {
        respond({ ok: false, error: `request exceeds ${String(maxBytes)} bytes` });
        return;
      }
      if (newline !== -1) {
        handleLine(buffered.subarray(0, newline).toString('utf8'));
        buffered = Buffer.alloc(0);
        // Anything after the first line is ignored: one request per connection.
        socket.removeAllListeners('data');
        socket.resume();
      }
    });
    socket.on('end', () => {
      if (answered || received) return;
      if (buffered.length > 0) handleLine(buffered.toString('utf8'));
      else respond({ ok: false, error: 'empty request' });
    });
    socket.on('error', () => {
      // A client that goes away mid-exchange is not the daemon's problem.
    });
    socket.on('close', () => {
      clearTimeout(timer);
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
