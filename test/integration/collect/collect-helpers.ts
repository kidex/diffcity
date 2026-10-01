// An in-process daemon with the collection plugin, for the collect/* tests:
// a temporary DIFFCITY_HOME, the inline snapshot runner unless asked
// otherwise, a stubbed gh, and an SSE recorder.

import { PassThrough } from 'node:stream';
import { afterEach } from 'vitest';
import type { CommandRunner } from '../../../src/core/git/index.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { dbPlugin } from '../../../src/daemon/db.js';
import { createCollection, type Collection, type CollectionPluginOptions } from '../../../src/daemon/collector/plugin.js';
import { startDaemon, type RunningDaemon } from '../../../src/daemon/daemon.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import type { DaemonPlugin } from '../../../src/daemon/plugin.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { waitFor } from '../../helpers/daemon.js';
import { fakeRunner, type RecordedCall } from '../../helpers/git-env.js';
import { createRepo, type CreateRepoOptions, type TempRepo } from '../../helpers/repo.js';

export interface TestDaemon {
  daemon: RunningDaemon;
  collection: Collection;
  home: TempHome;
  track(dir: string, agent?: boolean, at?: string): ReturnType<typeof sendRequest<{ v: 1; type: 'track'; dir: string; agent: boolean; at: string }>>;
  register(dirs: string[]): ReturnType<typeof sendRequest<{ v: 1; type: 'register'; dirs: string[] }>>;
  /** SSE events received so far, `hello` included. */
  events(): SseRecord[];
  /** Waits until no repo is collecting. */
  idle(timeoutMs?: number): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

export function cleanupAfterEach(): void {
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });
}

export interface SseRecord {
  event: string;
  data: Record<string, unknown>;
}

/** Reads GET /api/events continuously and parses every event as it arrives. */
async function recordSse(port: number): Promise<{ events: SseRecord[]; close: () => void }> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/events`, { signal: controller.signal });
  if (response.body === null) throw new Error('SSE response without a body');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseRecord[] = [];
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) events.push({ event: name, data: JSON.parse(data) as Record<string, unknown> });
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Aborted at cleanup.
    }
  })();
  await waitFor(() => events.some((record) => record.event === 'hello'), 5000, 'the SSE hello');
  return { events, close: () => { controller.abort(); } };
}

/**
 * `plugins` adds plugins after the collection (the watch plugin, say); they
 * start after it and stop before it.
 */
export async function startTestDaemon(
  options: CollectionPluginOptions = {},
  plugins: (collection: Collection) => DaemonPlugin[] = () => [],
): Promise<TestDaemon> {
  const home = await tempHome();
  const collection = createCollection({ runner: 'inline', poolSize: 2, ...options });
  const result = await startDaemon({
    env: home.env,
    port: 0,
    plugins: [dbPlugin, collection.plugin, ...plugins(collection)],
    log: createStreamLogger(new PassThrough()),
  });
  if (result.status !== 'started') throw new Error(`daemon did not start: ${result.status}`);
  const { daemon } = result;
  const sse = await recordSse(daemon.info.port);
  cleanups.push(async () => {
    sse.close();
    await daemon.shutdown('test cleanup');
    await home.cleanup();
  });
  const testDaemon: TestDaemon = {
    daemon,
    collection,
    home,
    track: (dir, agent = false, at = new Date().toISOString()) =>
      sendRequest(daemon.info.socket, { v: 1, type: 'track', dir, agent, at }),
    register: (dirs) => sendRequest(daemon.info.socket, { v: 1, type: 'register', dirs }),
    events: () => [...sse.events],
    idle: async (timeoutMs = 30_000) => {
      // Let a collection scheduled after a socket response start first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await waitFor(() => collection.collector().collecting === 0, timeoutMs, 'the collections to finish');
    },
  };
  return testDaemon;
}

/** A sample repo, removed after the test. */
export async function sampleRepo(options: CreateRepoOptions = {}): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: {
      'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.length;\n}\n',
      'README.md': '# sample-shop\n',
    },
    ...options,
  });
  cleanups.push(() => repo.cleanup());
  return repo;
}

/** gh installed and authenticated, answering `pr list` with `prs` (JSON). */
export function ghWithPrs(prs: () => unknown[]): { runner: CommandRunner; calls: RecordedCall[]; prListCalls: () => number } {
  const fake = fakeRunner((call) => {
    if (call.args[0] === '--version') return 'gh version 2.0.0\n';
    if (call.args[0] === 'auth') return '';
    if (call.args[0] === 'pr' && call.args[1] === 'list') return JSON.stringify(prs());
    throw new Error(`unexpected gh call: ${call.args.join(' ')}`);
  });
  return {
    runner: fake.runner,
    calls: fake.calls,
    prListCalls: () => fake.calls.filter((call) => call.args[0] === 'pr' && call.args[1] === 'list').length,
  };
}

/** gh not installed. */
export function ghNotInstalled(): CommandRunner {
  return fakeRunner(() => {
    throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  }).runner;
}
