// e2e/daemon-up-ui (ADR-015, ADR-017, ADR-023): the real daemon started by
// `diffcity up --foreground --no-open --port <free>` in a temporary
// DIFFCITY_HOME serves the built UI on 127.0.0.1. The top bar's daemon
// indicator is connected against it, goes offline once the daemon stops, and
// connects again when `up` starts a new daemon on the same port.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';

const CLI = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));

interface Daemon {
  readonly port: number;
  readonly baseURL: string;
  readonly home: string;
  /** Starts `up --foreground` and waits until /api/health answers. */
  start(): Promise<void>;
  /** Sends SIGTERM and resolves with the exit code. */
  stop(): Promise<number | null>;
}

interface Running {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The status of a GET sent with a forged Host header (fetch() cannot set Host). */
function statusWithHost(port: number, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once('error', reject);
    req.end();
  });
}

/** Reads an SSE stream until `marker` appears, then aborts it. */
async function readSseUntil(url: string, marker: string): Promise<{ contentType: string | null; text: string }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (response.body === null) throw new Error('SSE response without a body');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  controller.abort();
  return { contentType: response.headers.get('content-type'), text };
}

const test = base.extend<{ daemon: Daemon }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument.
  daemon: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'dc-e2e-'));
    const home = join(root, 'home');
    const user = join(root, 'user');
    await mkdir(user);
    const env = { ...process.env, DIFFCITY_HOME: home, HOME: user };
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${String(port)}`;
    const state: { running: Running | null } = { running: null };

    const daemon: Daemon = {
      port,
      baseURL,
      home,
      async start() {
        const child = spawn(process.execPath, [CLI, 'up', '--foreground', '--no-open', '--port', String(port)], {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { resolve(code); }));
        state.running = { child, exited };
        const deadline = Date.now() + 10_000;
        for (;;) {
          const ok = await fetch(`${baseURL}/api/health`).then(
            (response) => response.ok,
            () => false,
          );
          if (ok) return;
          if (child.exitCode !== null) throw new Error(`up exited with ${String(child.exitCode)}:\n${stderr}`);
          if (Date.now() > deadline) throw new Error(`the daemon did not answer within 10 s:\n${stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      async stop() {
        const running = state.running;
        if (running === null) return null;
        running.child.kill('SIGTERM');
        state.running = null;
        return running.exited;
      },
    };

    await use(daemon);

    // Never leave a daemon behind, even when the test failed half-way.
    const running = state.running;
    if (running !== null && running.child.exitCode === null) {
      running.child.kill('SIGTERM');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5_000));
      if ((await Promise.race([running.exited, timeout])) === 'timeout') running.child.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  },
});

const indicator = (page: Page) => page.getByTestId('daemon');

test('the UI served by the real daemon is connected, offline once the daemon stops, and connected again after up', async ({ page, daemon }) => {
  test.setTimeout(45_000);
  await daemon.start();

  // The daemon serves the built UI, not the "UI not built" page.
  await page.goto(`${daemon.baseURL}/#/`);
  await expect(page.getByText('UI not built')).toHaveCount(0);
  await expect(indicator(page)).toHaveAttribute('data-state', 'connected');
  await expect(indicator(page)).toHaveText('Connected');

  // SPA fallback: an unknown page path gets the same index.html.
  const index = await (await page.request.get(`${daemon.baseURL}/`)).text();
  const fallback = await page.request.get(`${daemon.baseURL}/some/deep/route`);
  expect(fallback.status()).toBe(200);
  expect(fallback.headers()['content-type']).toContain('text/html');
  expect(await fallback.text()).toBe(index);

  // The daemon stops: it exits cleanly, removes its files, and the UI notices.
  expect(await daemon.stop()).toBe(0);
  for (const file of ['daemon.json', 'daemon.lock']) expect(await exists(join(daemon.home, file))).toBe(false);
  await expect(indicator(page)).not.toHaveAttribute('data-state', 'connected');
  await expect(indicator(page)).toHaveAttribute('data-state', 'offline', { timeout: 10_000 });
  await expect(indicator(page)).toHaveText('Offline');

  // `up` again on the same port: the page reconnects without a reload.
  await daemon.start();
  await expect(indicator(page)).toHaveAttribute('data-state', 'connected', { timeout: 10_000 });
});

test('the real daemon answers /api/health and hello, and a foreign Host header gets 421', async ({ daemon }) => {
  await daemon.start();
  const health = (await (await fetch(`${daemon.baseURL}/api/health`)).json()) as { version: string; pid: number };
  expect(health.pid).toBeGreaterThan(0);

  expect(await statusWithHost(daemon.port, 'rebound.example')).toBe(421);
  expect(await statusWithHost(daemon.port, `127.0.0.1:${String(daemon.port)}`)).toBe(200);

  const sse = await readSseUntil(`${daemon.baseURL}/api/events`, 'event: hello');
  expect(sse.contentType).toContain('text/event-stream');
  expect(sse.text).toContain(`event: hello\ndata: {"version":${JSON.stringify(health.version)}`);
});
