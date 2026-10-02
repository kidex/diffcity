// Shared pieces of the proof specs (e2e/proof/DC-<nr>.spec.ts): videos that
// walk through a task's acceptance criteria as a user would, recorded by the
// `proof` Playwright project (`npm run proof -- DC-<nr>`).
//
// - `criterion()` shows a caption naming the criterion at the top of the page,
//   runs the step, then holds the frame so the video can be followed;
// - the `proof` fixture gives each spec a temporary root with DIFFCITY_HOME and
//   HOME inside it, starts the real daemon from dist/ on a free port, opens
//   shells with the built hook, and stops and removes everything afterwards.
//   The real ~/.config/diffcity is never touched.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, type Page } from '@playwright/test';
import { homePaths, HOME_ENV } from '../../../src/core/home.js';
import { CLI_DIST, stopDaemonIn } from '../../helpers/daemon.js';
import { freePort, openShell, type ShellSession, type ShellSpec } from './acceptance.js';

/** How long each criterion stays on screen once its step is done. */
export const HOLD_MS = 1800;

const CAPTION_ID = 'diffcity-proof-caption';
const ACCENT = '#f5b83d';

/**
 * Shows (or replaces) the caption: a dark band fixed at the top of the
 * viewport with `title` and an optional monospace `detail` line. The band hangs
 * from <html>, outside the app, and the app's <body> is shifted down by its
 * height, so the caption never covers the app's header. It ignores the
 * pointer. The script is a string because the test tsconfig has no DOM types.
 */
export async function showCaption(page: Page, title: string, detail?: string): Promise<void> {
  await page.evaluate(`(() => {
    const id = ${JSON.stringify(CAPTION_ID)};
    let box = document.getElementById(id);
    if (box === null) {
      box = document.createElement('div');
      box.id = id;
      box.setAttribute('aria-hidden', 'true');
      Object.assign(box.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', boxSizing: 'border-box',
        pointerEvents: 'none', padding: '14px 28px', background: '#0c0e14',
        borderBottom: '4px solid ${ACCENT}', color: '#ffffff',
        font: '600 22px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif',
      });
      document.documentElement.appendChild(box);
    }
    box.replaceChildren();
    const title = document.createElement('div');
    title.textContent = ${JSON.stringify(title)};
    box.appendChild(title);
    const detail = ${JSON.stringify(detail ?? null)};
    if (detail !== null) {
      const line = document.createElement('div');
      line.textContent = detail;
      Object.assign(line.style, { marginTop: '4px', color: '${ACCENT}', font: '500 16px/1.4 ui-monospace, Menlo, monospace' });
      box.appendChild(line);
    }
    // A transform also moves the app's fixed elements, unlike a margin.
    document.body.style.transform = 'translateY(' + String(box.offsetHeight) + 'px)';
  })()`);
}

/** Removes the caption and puts the app back at the top of the viewport. */
export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    document.getElementById(${JSON.stringify(CAPTION_ID)})?.remove();
    if (document.body !== null) document.body.style.transform = '';
  })()`);
}

/**
 * A full-page title card, shown while a spec prepares its fixture repos and
 * daemon so the first seconds of the video say what it proves instead of
 * showing a blank page.
 */
export async function titleCard(page: Page, heading: string, lines: readonly string[]): Promise<void> {
  const escape = (text: string): string => text.replace(/[&<>"]/g, (char) => `&#${String(char.charCodeAt(0))};`);
  await page.setContent(`<!doctype html>
<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;padding:0 120px;
  background:#0c0e14;color:#ffffff;font:500 26px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="color:${ACCENT};font:600 20px/1.4 ui-monospace,Menlo,monospace;letter-spacing:0.08em">diffcity proof</div>
  <h1 style="margin:12px 0 28px;font-size:48px;line-height:1.2">${escape(heading)}</h1>
  ${lines.map((line) => `<div style="color:#c9cdd8">${escape(line)}</div>`).join('\n  ')}
</body></html>`);
}

/**
 * One acceptance criterion in the video: a Playwright step named `title`
 * that shows the caption, runs `body` (the user's action and the check that
 * the criterion holds), re-shows the caption in case a navigation dropped it,
 * and holds the frame for HOLD_MS.
 */
export async function criterion(page: Page, title: string, body: () => Promise<void>, detail?: string): Promise<void> {
  await base.step(title, async () => {
    await showCaption(page, title, detail);
    await page.waitForTimeout(HOLD_MS / 2);
    await body();
    await showCaption(page, title, detail);
    await page.waitForTimeout(HOLD_MS);
  });
}

export interface ProofWorld {
  /** Temporary root: DIFFCITY_HOME (`home`), HOME (`user`) and anything the spec adds. */
  readonly root: string;
  readonly home: string;
  /** The environment with DIFFCITY_HOME and HOME pointing into `root`. */
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly baseURL: string;
  /** Starts `up --foreground --no-open --port <port>` with `env` and waits for /api/health. */
  startDaemon(env?: NodeJS.ProcessEnv): Promise<void>;
  /** An interactive shell in `root` with the built hook loaded; closed at teardown. */
  shell(spec: ShellSpec, env?: NodeJS.ProcessEnv): Promise<ShellSession>;
  /** Runs `cleanup` at teardown, after the shells and the daemon stopped. */
  onTeardown(cleanup: () => Promise<void>): void;
}

export const test = base.extend<{ proof: ProofWorld }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first argument.
  proof: async ({}, use, testInfo) => {
    // Short prefix: <root>/home/daemon.sock must fit the socket path limit.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-proof-')));
    const home = join(root, 'home');
    const user = join(root, 'user');
    await mkdir(user);
    const env: NodeJS.ProcessEnv = { ...process.env, [HOME_ENV]: home, HOME: user };
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${String(port)}`;
    const shells: ShellSession[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const daemon: { child: ChildProcess | null } = { child: null };
    const foregroundLog = join(root, 'daemon-foreground.log');

    const world: ProofWorld = {
      root,
      home,
      env,
      port,
      baseURL,
      async startDaemon(daemonEnv = env) {
        const log = createWriteStream(foregroundLog);
        const child = spawn(process.execPath, [CLI_DIST, 'up', '--foreground', '--no-open', '--port', String(port)], {
          env: daemonEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.pipe(log);
        child.stderr.pipe(log);
        daemon.child = child;
        const deadline = Date.now() + 15_000;
        for (;;) {
          const ok = await fetch(`${baseURL}/api/health`).then((response) => response.ok, () => false);
          if (ok) return;
          if (child.exitCode !== null) throw new Error(`up exited with ${String(child.exitCode)}`);
          if (Date.now() > deadline) throw new Error('the daemon did not answer within 15 s');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      async shell(spec, shellEnv = env) {
        const session = await openShell(spec, root, shellEnv, root);
        shells.push(session);
        return session;
      },
      onTeardown(cleanup) {
        cleanups.push(cleanup);
      },
    };

    await use(world);

    for (const session of shells) await session.close();
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [name, path] of [['daemon.log', homePaths(home).log], ['daemon-foreground.log', foregroundLog]] as const) {
        if (existsSync(path)) await testInfo.attach(name, { path, contentType: 'text/plain' });
      }
    }
    // Never leave a daemon behind: the foreground one, and any one a hook started.
    const running = daemon.child;
    if (running !== null && running.exitCode === null && running.signalCode === null) {
      const exited = new Promise((resolve) => running.once('exit', resolve));
      running.kill('SIGTERM');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5000));
      if ((await Promise.race([exited, timeout])) === 'timeout') running.kill('SIGKILL');
    }
    await stopDaemonIn(home);
    for (const cleanup of cleanups) await cleanup();
    await rm(root, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
