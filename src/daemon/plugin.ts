// How later parts of the daemon plug in without editing its core files:
// the collection (DC-29) registers the `track` and `register` socket handlers,
// the JSON API (DC-31) registers its HTTP routes, the watcher and scheduler
// (DC-33) start and stop with the daemon. Each is a DaemonPlugin listed in
// src/daemon/plugins.ts.

import type { FastifyInstance } from 'fastify';
import type { HomePaths } from '../core/home.js';
import type { SseEvent } from '../core/model/types.js';
import type { Logger } from './log.js';
import type { SocketHandlerRegistry } from './socket/server.js';

export interface DaemonContext {
  readonly version: string;
  readonly pid: number;
  /** ISO time the daemon started. */
  readonly startedAt: string;
  readonly paths: HomePaths;
  /** The environment the daemon runs with (DIFFCITY_HOME, PATH for git and gh). */
  readonly env: NodeJS.ProcessEnv;
  readonly log: Logger;
  /** Sends a signal to every SSE client (ADR-017). */
  broadcast(event: SseEvent): void;
  /** `track` and `register` handlers (ADR-016). */
  readonly socket: SocketHandlerRegistry;
  /** Supplies the `collecting` count of /api/health; 0 until set. */
  setCollectingCounter(count: () => number): void;
  /** The HTTP port; 0 until the server listens. */
  port(): number;
  /** Starts a graceful shutdown, as SIGTERM or the `shutdown` request do. */
  requestShutdown(reason: string): void;
}

export interface DaemonPlugin {
  readonly name: string;
  /**
   * Before the servers listen: register socket handlers and HTTP routes on
   * `http` (under /api/), open resources such as the database. A throw aborts
   * the start.
   */
  setup?(context: DaemonContext, http: FastifyInstance): void | Promise<void>;
  /** After daemon.json is written: start watchers, schedulers, the first collections. */
  start?(context: DaemonContext): void | Promise<void>;
  /**
   * On shutdown, in reverse plugin order, after the servers stopped accepting
   * requests and before daemon.json, the socket and the lock are removed.
   *
   * Called at most once, for every plugin whose `setup` was called, including
   * when `setup` itself threw, when `start` never ran (a later plugin's setup
   * failed, or the port was taken) or when `start` threw. A stop must therefore
   * release only what was actually acquired and tolerate never having started.
   *
   * Errors are logged and do not stop the other plugins. The servers and all
   * stops share a deadline (SHUTDOWN_TIMEOUT_MS, 10 s), and a second SIGTERM or
   * SIGINT stops waiting at once: a stop still pending then is abandoned and the
   * process exits with code 1.
   */
  stop?(context: DaemonContext): void | Promise<void>;
}
