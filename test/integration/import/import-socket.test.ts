// The `import` socket request against an in-process daemon (ADR-036, SPEC.md
// section 5.6): resolve the change checked out in `dir`, wait up to 20 s for a
// snapshot at the current content (else the previous one), anchor, store, the
// `import` event and SSE `findings`; the 4 MiB cap of an import line.

import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FindingInput } from '../../../src/core/findings/index.js';
import type { SocketRequest, SocketResponseFor } from '../../../src/core/model/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { MAX_IMPORT_REQUEST_BYTES, MAX_REQUEST_BYTES } from '../../../src/daemon/socket/protocol.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import type { TempRepo } from '../../helpers/repo.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

type ImportRequest = Extract<SocketRequest, { type: 'import' }>;

const SUMMED = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';

const finding = (over: Partial<FindingInput> = {}): FindingInput => ({
  source: 'claude',
  severity: 'high',
  category: 'correctness',
  file: 'src/cart/total.ts',
  line: 2,
  title: 'Total ignores negative items',
  message: 'A refund line makes the total smaller than the paid amount.',
  ...over,
});

function importRequest(dir: string, findings: FindingInput[], over: Partial<ImportRequest> = {}): ImportRequest {
  return { v: 1, type: 'import', dir, findings, warnings: [], sources: ['claude'], at: new Date().toISOString(), ...over };
}

function send(test: TestDaemon, request: ImportRequest): Promise<SocketResponseFor<'import'>> {
  return sendRequest(test.daemon.info.socket, request, { timeoutMs: 40_000 });
}

/** sample-shop on feature/totals, one commit ahead of main, checked out. */
async function shopOnBranch(): Promise<TempRepo> {
  const repo = await sampleRepo();
  await repo.branch('feature/totals');
  await repo.commit('sum the cart', { 'src/cart/total.ts': SUMMED });
  return repo;
}

async function tracked(test: TestDaemon, repo: TempRepo): Promise<number> {
  const response = await test.track(repo.dir);
  if (!response.ok) throw new Error(response.error);
  await test.idle();
  return response.repo.id;
}

/** Writes raw bytes and collects everything the server sends until it closes. */
function raw(path: string, payload: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE' || error.code === 'ECONNRESET') resolve(received);
      else reject(error);
    });
    socket.write(payload);
  });
}

describe('import over the socket (ADR-036)', () => {
  it('import/socket-roundtrip: anchors to the checked-out change, stores, writes the event and sends SSE findings', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const repoId = await tracked(test, repo);
    const db = test.collection.db();
    const change = db.changes.listLive(repoId).find((candidate) => candidate.ref === 'branch:feature/totals');
    if (change === undefined) throw new Error('change not collected');

    const reply = await send(test, importRequest(join(repo.dir, 'src'), [finding()]));
    expect(reply).toEqual({
      ok: true,
      change: { id: change.id, repoId, ref: 'branch:feature/totals' },
      imported: 1,
      merged: 0,
      skipped: 0,
      fixed: 0,
      warnings: [],
      anchoredAgainst: 'current-snapshot',
    });
    const [stored] = db.findings.list(change.id);
    expect(stored?.finding).toMatchObject({ file: 'src/cart/total.ts', line: 2, symbolId: expect.stringContaining('total') as unknown, state: 'open' });
    const events = db.events.listForRepo(repoId).filter((event) => event.type === 'import');
    expect(events).toEqual([
      expect.objectContaining({ changeId: change.id, payload: expect.objectContaining({ imported: 1, merged: 0, skipped: 0, fixed: 0, sources: ['claude'], anchoredAgainst: 'current-snapshot' }) as unknown }),
    ]);
    await expect.poll(() => test.events()).toContainEqual({ event: 'findings', data: { repoId, changeId: change.id } });

    const again = await send(test, importRequest(repo.dir, [finding(), finding({ source: 'semgrep', line: 1 })], { sources: ['claude', 'semgrep'] }));
    expect(again).toMatchObject({ ok: true, imported: 2, merged: 2, skipped: 0 });
    await test.idle();
  });

  it('an import that fixes a finding reports the same fixed count in its reply and its event', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const repoId = await tracked(test, repo);
    const first = await send(test, importRequest(repo.dir, [finding()]));
    expect(first).toMatchObject({ ok: true, imported: 1, fixed: 0 });
    // The symbol changes and claude no longer reports the finding: it is fixed.
    await repo.write({ 'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.filter((item) => item > 0).reduce((a, b) => a + b, 0);\n}\n' });
    const second = await send(test, importRequest(repo.dir, []));
    expect(second).toMatchObject({ ok: true, imported: 0, fixed: 1, anchoredAgainst: 'current-snapshot' });
    const events = test.collection.db().events.listForRepo(repoId).filter((event) => event.type === 'import');
    expect(events.map((event) => (event.payload as { fixed: number }).fixed).sort()).toEqual([0, 1]);
    await test.idle();
  });

  it('import/waits-for-snapshot: a file written just before the import is part of the snapshot the findings anchor to', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    await tracked(test, repo);
    await repo.write({ 'src/cart/discount.ts': 'export function discount(total: number): number {\n  return total * 0.9;\n}\n' });

    const reply = await send(test, importRequest(repo.dir, [finding({ file: 'src/cart/discount.ts', line: 2, title: 'Discount is hard-coded' })]));
    expect(reply).toMatchObject({ ok: true, imported: 1, skipped: 0, anchoredAgainst: 'current-snapshot' });
    if (!reply.ok) return;
    const [stored] = test.collection.db().findings.list(reply.change.id);
    expect(stored?.finding.symbolId).toEqual(expect.stringContaining('discount'));
    await test.idle();
  });

  it('import/previous-snapshot-fallback: no snapshot in time stores against the last one and says so', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled(), importWaitMs: 1 });
    await tracked(test, repo);
    await repo.write({ 'src/cart/discount.ts': 'export function discount(total: number): number {\n  return total * 0.9;\n}\n' });

    const reply = await send(test, importRequest(repo.dir, [finding(), finding({ file: 'src/cart/discount.ts', line: 2, title: 'Discount is hard-coded' })]));
    expect(reply).toMatchObject({
      ok: true,
      imported: 1,
      skipped: 1,
      anchoredAgainst: 'previous-snapshot',
      warnings: [{ at: 'src/cart/discount.ts:2', message: 'skipped-not-in-change: "src/cart/discount.ts" is not part of the change' }],
    });
    if (!reply.ok) return;
    expect(test.collection.db().findings.list(reply.change.id).map((entry) => entry.finding.file)).toEqual(['src/cart/total.ts']);
    await test.idle();
  });

  it('import/over-64k-accepted-under-4m: an import line past 64 KiB is read whole', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    await tracked(test, repo);
    const many = Array.from({ length: 400 }, (_, index) => finding({ title: `Invented finding number ${String(index)}`, message: 'm'.repeat(200) }));
    const request = importRequest(repo.dir, many);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(await send(test, request)).toMatchObject({ ok: true, imported: 400, merged: 0 });
  });

  it('import/over-4m-refused: an import line past 4 MiB is refused without waiting for its end, and the daemon keeps serving', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const head = Buffer.from('{"v":1,"type":"import","findings":["');
    const reply = await raw(test.daemon.info.socket, Buffer.concat([head, Buffer.alloc(MAX_IMPORT_REQUEST_BYTES, 'a')]));
    expect(JSON.parse(reply)).toEqual({ ok: false, error: `request exceeds ${String(MAX_IMPORT_REQUEST_BYTES)} bytes` });
    expect(await sendRequest(test.daemon.info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
  });

  it('a line past 64 KiB that does not start as an import is still refused at 64 KiB', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const reply = await raw(test.daemon.info.socket, Buffer.from(`{"v":1,"type":"track","dir":"${'d'.repeat(MAX_REQUEST_BYTES)}`));
    expect(JSON.parse(reply)).toEqual({ ok: false, error: `request exceeds ${String(MAX_REQUEST_BYTES)} bytes` });
  });

  it('import/registers-unknown-repo: an import from a repo the daemon never saw registers it and collects it first', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const reply = await send(test, importRequest(repo.dir, [finding()]));
    expect(reply).toMatchObject({ ok: true, imported: 1, change: { ref: 'branch:feature/totals' }, anchoredAgainst: 'current-snapshot' });
    const repos = test.collection.db().repos.list();
    expect(repos).toEqual([expect.objectContaining({ name: 'sample-shop', active: true })]);
    await test.idle();
  });

  it('import/outside-repo-error: a dir outside any git repository is an error', async () => {
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const outside = await mkdtemp(join(tmpdir(), 'dc-outside-'));
    try {
      const reply = await send(test, importRequest(outside, [finding()]));
      expect(reply).toEqual({ ok: false, error: expect.stringMatching(/not a git repository/) as unknown });
      expect(test.collection.db().repos.list()).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('a clean working tree on the base has no change to import into', async () => {
    const repo = await sampleRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    await tracked(test, repo);
    const reply = await send(test, importRequest(repo.dir, [finding()]));
    expect(reply).toEqual({ ok: false, error: expect.stringMatching(/^no change is checked out in .*: nothing differs from the base$/) as unknown });
  });

  it('a payload the parsers would never produce is refused before anything runs', async () => {
    const repo = await shopOnBranch();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const reply = await send(test, importRequest(repo.dir, [finding({ file: '../escape.ts' })]));
    expect(reply).toEqual({ ok: false, error: 'invalid import request: findings[0].file must be a normalized repo-relative path' });
    expect(test.collection.db().repos.list()).toEqual([]);
  });
});
