// integration/track-to-api-under-5s (SPEC.md section 9, ADR-023): a real
// daemon from dist/, in a temporary DIFFCITY_HOME, with gh replaced by a stub
// script on PATH. `track` on the socket for sample-shop (a Draft, a Branch and
// a PR); within 5 s the database holds the repo, its three changes and a
// snapshot for each.
//
// The HTTP routes arrive with DC-31, so the check reads the daemon's database
// directly (a read-only connection; WAL lets it read while the daemon writes).
// Once /api/repos/:id exists, the same deadline can be asserted through it.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { devNull } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { readDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { DaemonTracker, waitFor } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { rawConnection } from '../../unit/db/db-helpers.js';

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

const GH_STUB = `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;
  auth) exit 0 ;;
  pr) if [ "$2" = "list" ]; then cat "$GH_STUB_PR_LIST"; exit 0; fi ;;
esac
exit 1
`;

describe('integration/track-to-api-under-5s', () => {
  it('track → the repo, its 3 changes and their snapshots are in the database within 5 s', async () => {
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
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
    };

    const daemon = daemons.spawnDaemon(env);
    const paths = homePaths(home.home);
    const info = await waitFor(() => readDaemonInfo(paths).catch(() => null).then((value) => value ?? undefined), 20_000, 'daemon.json');

    const t0 = performance.now();
    const response = await sendRequest(info.socket, { v: 1, type: 'track', dir: repo.dir, agent: false, at: new Date().toISOString() });
    const answeredMs = performance.now() - t0;
    expect(response).toEqual({ ok: true, repo: { id: 1, name: 'sample-shop' } });

    const db = rawConnection(paths.db, { readOnly: true });
    try {
      const ready = db.prepare<[], { repos: number; changes: number; snapshotted: number }>(
        `SELECT (SELECT count(*) FROM repos) AS repos,
                (SELECT count(*) FROM changes WHERE archivedAt IS NULL) AS changes,
                (SELECT count(*) FROM changes c WHERE c.archivedAt IS NULL
                   AND EXISTS (SELECT 1 FROM snapshots s WHERE s.changeId = c.id)) AS snapshotted`,
      );
      await waitFor(
        () => {
          const row = ready.get();
          return row !== undefined && row.repos === 1 && row.changes === 3 && row.snapshotted === 3;
        },
        // Waits past the deadline, so a miss still reports how long it took.
        30_000,
        'three changes with snapshots',
      );
      const elapsedMs = performance.now() - t0;
      const kinds = db
        .prepare<[], { kind: string; ref: string }>('SELECT kind, ref FROM changes WHERE archivedAt IS NULL ORDER BY ref')
        .all()
        .map((row) => `${row.kind} ${row.ref}`);
      expect(kinds).toEqual(['branch branch:feature/menu', 'draft draft:.', 'pr pr:7']);
      // Measured for the phase report; visible with --reporter=verbose.
      const measured = `track answered in ${answeredMs.toFixed(0)} ms; 3 changes with snapshots in ${elapsedMs.toFixed(0)} ms`;
      console.info(measured);
      // The daemon logs each collection's sources and snapshot times.
      const log = await readFile(paths.log, 'utf8').catch(() => '');
      expect(elapsedMs, `${measured}\ndaemon.log:\n${log}`).toBeLessThan(DEADLINE_MS);
    } finally {
      db.close();
    }
    expect(daemon.stderr()).toBe('');
  });
});
