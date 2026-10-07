// PUT /api/changes/:id/findings/:key/state signals `findings` (the change's
// Report moved), `changes` (its listed counts moved) and `repo` (the repo's
// highFindings moved, so Fleet reloads; DC-106), through fastify.inject on a
// seeded temporary database.

import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anchor } from '../../../src/core/findings/index.js';
import type { ChangeRecord, RepoRecord, SseEvent } from '../../../src/core/model/types.js';
import { registerApiRoutes } from '../../../src/daemon/api/routes.js';
import { buildHttpServer } from '../../../src/daemon/http/server.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { createSseHub, type SseHub } from '../../../src/daemon/sse.js';
import { sampleReport } from '../review/review-helpers.js';
import { addRepo, branchFields, snapshotInput, T0, tempDb, type TempDb } from '../db/db-helpers.js';

const PORT = 4321;

let temp: TempDb;
let hub: SseHub;
let app: FastifyInstance;
let repo: RepoRecord;
let change: ChangeRecord;
let findingKey: string;
const sent: SseEvent[] = [];

beforeEach(async () => {
  temp = tempDb();
  const { db } = temp;
  repo = addRepo(db, 'corner-till');
  const created = db.changes.applyPlan(repo.id, { create: [branchFields('till')], update: [], archive: [] }, T0).created[0];
  if (created === undefined) throw new Error('no change');
  change = created;
  const report = { ...sampleReport(), meta: { ...sampleReport().meta, head: change.head } };
  db.snapshots.put(snapshotInput(change.id, change.head, { report: JSON.stringify(report), contentHash: 'till-1' }));
  const result = anchor(
    { source: 'claude', severity: 'high', category: 'correctness', file: 'src/cart/tax.ts', line: 2, title: 'Rate read too early', message: 'Reads the rate early.' },
    report,
  );
  if (!result.ok) throw new Error('not anchored');
  findingKey = result.stored.key;
  db.findings.importBatch({ changeId: change.id, head: change.head, findings: [result.stored], fixed: [], at: T0 });

  sent.length = 0;
  hub = createSseHub({ hello: () => ({ version: '9.9.9', startedAt: T0 }) });
  app = await buildHttpServer({
    version: '9.9.9',
    pid: 123,
    startedAt: T0,
    uiDir: '/nonexistent-ui',
    sse: hub,
    collecting: () => 0,
    log: createStreamLogger(new PassThrough()),
    port: () => PORT,
  });
  registerApiRoutes(app, { db, port: () => PORT, open: () => undefined, broadcast: (event) => sent.push(event) });
});
afterEach(async () => {
  hub.close();
  await app.close();
  temp.cleanup();
});

describe('findings state signals', () => {
  it('a state write sends `findings` for the change, then `changes` and `repo` for its repo', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/changes/${String(change.id)}/findings/${findingKey}/state`,
      headers: { host: `127.0.0.1:${String(PORT)}`, origin: `http://127.0.0.1:${String(PORT)}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ state: 'intended' }),
    });
    expect(response.statusCode).toBe(200);
    expect(sent).toEqual([
      { event: 'findings', data: { repoId: repo.id, changeId: change.id } },
      { event: 'changes', data: { repoId: repo.id } },
      { event: 'repo', data: { repoId: repo.id } },
    ]);
  });
});
