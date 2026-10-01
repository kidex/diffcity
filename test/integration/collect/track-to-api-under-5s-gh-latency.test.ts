// integration/track-to-api-under-5s-gh-latency (SPEC.md section 9, ADR-023):
// the same flow as track-to-api-under-5s, with every gh call of the stub
// delayed by 1.5 s to model the latency of a real gh talking to GitHub
// (`gh auth status` and `gh pr list` both reach the network). Within 5 s of
// `track`, GET /api/repos/:id still lists the three changes, each with stats.
//
// Runs in the vitest `timing` project (vitest.config.ts), one file at a time and
// after every other test: beside other test files, the deadline would measure
// the machine's load instead of the collector.

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { devNull } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import type { RepoDetail } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

const DEADLINE_MS = 5000;

const daemons = new DaemonTracker();
let home: TempHome | null = null;
let repo: TempRepo | null = null;
afterEach(async () => {
  await daemons.cleanup();
  await repo?.cleanup();
  await home?.cleanup();
  repo = null;
  home = null;
});

const GH_DELAY_S = '1.5';

const GH_STUB = `#!/bin/sh
sleep "$GH_STUB_DELAY"
case "$1" in
  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;
  auth) exit 0 ;;
  pr) if [ "$2" = "list" ]; then cat "$GH_STUB_PR_LIST"; exit 0; fi ;;
esac
exit 1
`;

describe('integration/track-to-api-under-5s-gh-latency', () => {
  it('with gh answering in 1.5 s, track → GET /api/repos/:id lists the 3 changes, each with stats, within 5 s', async () => {
    home = await tempHome();
    repo = await createRepo({
      name: 'sample-shop',
      files: { 'src/cart/total.ts': 'export const total = 0;\n', 'README.md': '# sample-shop\n' },
    });
    await repo.branch('feature/menu');
    await repo.commit('add the menu', { 'src/menu/dish.ts': 'export function dish(): string {\n  return "soup";\n}\n' });
    await repo.checkout('main');
    await repo.branch('feature/checkout');
    const prHead = await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export class Pay {}\n' });
    await repo.checkout('main');
    await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });

    const stubDir = join(home.root, 'bin');
    await mkdir(stubDir);
    await writeFile(join(stubDir, 'gh'), GH_STUB);
    await chmod(join(stubDir, 'gh'), 0o755);
    const prList = join(home.root, 'pr-list.json');
    await writeFile(
      prList,
      JSON.stringify([
        { number: 7, title: 'Checkout flow', headRefName: 'feature/checkout', headRefOid: prHead, baseRefName: 'main', isCrossRepository: false },
      ]),
    );
    const env: NodeJS.ProcessEnv = {
      ...home.env,
      PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`,
      GH_STUB_PR_LIST: prList,
      GH_STUB_DELAY: GH_DELAY_S,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
    };

    // The first exec of a freshly written script pays macOS's provenance check;
    // pay it here, outside the measured window.
    execFileSync(join(stubDir, 'gh'), ['--version'], { env: { ...env, GH_STUB_DELAY: '0' } });
    const daemon = daemons.spawnDaemon(env);
    const paths = homePaths(home.home);
    const info = await waitFor(() => readDaemonInfo(paths).catch(() => null).then((value) => value ?? undefined), 20_000, 'daemon.json');

    const t0 = performance.now();
    const response = await sendRequest(info.socket, { v: 1, type: 'track', dir: repo.dir, agent: false, at: new Date().toISOString() });
    const answeredMs = performance.now() - t0;
    expect(response).toEqual({ ok: true, repo: { id: 1, name: 'sample-shop' } });

    const repoUrl = `http://127.0.0.1:${String(info.port)}/api/repos/${String(response.ok ? response.repo.id : 0)}`;
    const detail = await waitFor(
      async () => {
        const reply = await fetch(repoUrl);
        if (!reply.ok) return undefined;
        const body = (await reply.json()) as RepoDetail;
        return body.changes.length === 3 && body.changes.every((change) => change.stats !== null) ? body : undefined;
      },
      // Waits past the deadline, so a miss still reports how long it took.
      30_000,
      'three changes with stats on /api/repos/:id',
    );
    const elapsedMs = performance.now() - t0;
    expect(detail.repo.name).toBe('sample-shop');
    expect(detail.changes.map((change) => `${change.kind} ${change.ref}`).sort()).toEqual([
      'branch branch:feature/menu',
      'draft draft:.',
      'pr pr:7',
    ]);
    // Measured for the phase report; visible with --reporter=verbose.
    const measured = `gh delay ${GH_DELAY_S} s: track answered in ${answeredMs.toFixed(0)} ms; 3 changes with stats in ${elapsedMs.toFixed(0)} ms`;
    console.info(measured);
    // The daemon logs each collection's sources and snapshot times.
    const log = await readFile(paths.log, 'utf8').catch(() => '');
    expect(elapsedMs, `${measured}\ndaemon.log:\n${log}`).toBeLessThan(DEADLINE_MS);
    expect(daemon.stderr()).toBe('');
  });
});
