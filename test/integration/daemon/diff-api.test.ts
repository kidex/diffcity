// GET /api/changes/:id/diff (ADR-027) over HTTP against an in-process daemon
// with a real collection of invented repos in temporary homes: membership,
// path hardening, symlinks, cross-site, repo-configured commands, snapshots
// that predate the file view and the refresh of a dirty change (DC-74).

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiError, FileDiff } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { waitFor } from '../../helpers/daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { call } from '../../helpers/review-api.js';
import type { TempRepo } from '../../helpers/repo.js';
import { addRepo, branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const scratches: string[] = [];
afterEach(async () => {
  while (scratches.length > 0) await rm(scratches.pop() as string, { recursive: true, force: true });
});

const body = (n: number): string => `export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, ${String(n)});\n}\n`;
const TAX = 'export function tax(amount: number): number {\n  return amount * 0.2;\n}\n';

interface Collected {
  test: TestDaemon;
  port: number;
  repo: TempRepo;
  changeId: number;
  repoId: number;
  report: () => Report;
}

/** Tracks `repo` with a daemon and waits for the snapshot of its draft (the working tree) or of `branch:<ref>`. */
async function collect(repo: TempRepo, ref: string, runner: 'inline' | 'thread' = 'inline'): Promise<Collected> {
  const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true, diffRunner: runner });
  const tracked = await test.track(repo.dir);
  if (!tracked.ok) throw new Error(tracked.error);
  await test.idle();
  const db = test.collection.db();
  const change = db.changes.listLive(tracked.repo.id).find((c) => c.ref === ref || (ref === 'draft' && c.kind === 'draft'));
  if (change === undefined) throw new Error(`${ref} not collected`);
  return {
    test,
    port: test.daemon.info.port,
    repo,
    changeId: change.id,
    repoId: tracked.repo.id,
    report: () => {
      const snapshot = db.snapshots.latest(change.id);
      if (snapshot === null) throw new Error('no snapshot');
      return JSON.parse(snapshot.report) as Report;
    },
  };
}

const diffUrl = (changeId: number, path: string, symbol?: string): string =>
  `/api/changes/${String(changeId)}/diff?path=${encodeURIComponent(path)}${symbol === undefined ? '' : `&symbol=${encodeURIComponent(symbol)}`}`;

const errorCode = (answer: { json(): unknown }): string => (answer.json() as ApiError).error.code;

async function draftWithTwoEdits(): Promise<Collected> {
  const repo = await sampleRepo();
  await repo.write({ 'src/cart/total.ts': body(0), 'src/cart/tax.ts': TAX });
  return collect(repo, 'draft');
}

describe('api/diff-route', () => {
  it('serves the diff of a file of a working tree change with a symbol focus, uncached by the browser', async () => {
    const { port, changeId, report } = await draftWithTwoEdits();
    const file = report().packages.flatMap((p) => p.files).find((f) => f.path === 'src/cart/total.ts');
    const symbol = file?.symbols.find((s) => s.name === 'total');
    if (file === undefined || symbol === undefined) throw new Error('total.ts or its symbol is not in the report');

    const answer = await call(port, 'GET', diffUrl(changeId, file.id, symbol.id));
    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('application/json; charset=utf-8');
    const diff = answer.json() as FileDiff;
    expect(diff).toMatchObject({ kind: 'text', path: 'src/cart/total.ts', language: 'typescript', stale: false });
    expect(diff.rows?.some((row) => row.kind === 'add' && row.text.includes('a + b, 0'))).toBe(true);
    expect(diff.focus?.id).toBe(symbol.id);
    expect(diff.rows?.some((row) => (row.hl ?? []).length > 0)).toBe(true);

    // The no-store header is also on an error.
    const missing = await fetch(`http://127.0.0.1:${String(port)}${diffUrl(changeId, 'src/none.ts')}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const ok = await fetch(`http://127.0.0.1:${String(port)}${diffUrl(changeId, file.id)}`);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    await ok.text();
  });

  it('computes in the built worker thread too', async () => {
    const { port, changeId } = await (async () => {
      const repo = await sampleRepo();
      await repo.write({ 'src/cart/total.ts': body(0) });
      return collect(repo, 'draft', 'thread');
    })();
    const answer = await call(port, 'GET', diffUrl(changeId, 'src/cart/total.ts'));
    expect(answer.status).toBe(200);
    const diff = answer.json() as FileDiff;
    expect(diff.kind).toBe('text');
    expect(diff.rows?.some((row) => (row.hl ?? []).length > 0)).toBe(true);
  });

  it('answers a branch change from its commits, and an untouched file as unchanged', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/totals');
    await repo.commit('sum', { 'src/cart/total.ts': body(0) });
    await repo.checkout('main');
    const { port, changeId } = await collect(repo, 'branch:feature/totals');
    const touched = (await call(port, 'GET', diffUrl(changeId, 'src/cart/total.ts'))).json() as FileDiff;
    expect(touched).toMatchObject({ kind: 'text', stale: false, stats: { added: 1, removed: 1 } });
    expect(touched.head).toBe(await repo.git('rev-parse', 'feature/totals'));
  });
});

describe('api/diff-not-in-snapshot-404', () => {
  it('answers 404 not-in-snapshot for a path that is on disk but not in the snapshot, and 404 for an unknown change or symbol', async () => {
    const { port, changeId, report } = await draftWithTwoEdits();
    const missing = await call(port, 'GET', diffUrl(changeId, 'README.md'));
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('not-in-snapshot');
    // Own keys only.
    for (const path of ['constructor', '__proto__', 'toString']) {
      expect(errorCode(await call(port, 'GET', diffUrl(changeId, path)))).toBe('not-in-snapshot');
    }

    const files = report().packages.flatMap((p) => p.files);
    const total = files.find((f) => f.path === 'src/cart/total.ts');
    const tax = files.find((f) => f.path === 'src/cart/tax.ts');
    const taxSymbol = tax?.symbols[0];
    if (total === undefined || taxSymbol === undefined) throw new Error('report is not as expected');
    // A symbol of another file, and one that does not exist.
    expect(errorCode(await call(port, 'GET', diffUrl(changeId, total.id, taxSymbol.id)))).toBe('not-in-snapshot');
    expect(errorCode(await call(port, 'GET', diffUrl(changeId, total.id, `${total.id}#nope`)))).toBe('not-in-snapshot');

    expect((await call(port, 'GET', diffUrl(9999, total.id))).status).toBe(404);
    expect(errorCode(await call(port, 'GET', diffUrl(9999, total.id)))).toBe('not-found');
    expect((await call(port, 'GET', '/api/changes/abc/diff?path=x')).status).toBe(400);
    expect((await call(port, 'GET', `/api/changes/${String(changeId)}/diff`)).status).toBe(400);
  });
});

describe('api/diff-traversal-rejected', () => {
  it('refuses ../, absolute, NUL, backslash and dot segments with 400, and a pathspec magic path is just not in the snapshot', async () => {
    const { port, changeId } = await draftWithTwoEdits();
    const refused = ['../outside.ts', 'src/../../etc/passwd', '/etc/passwd', 'src/cart/total.ts\0', 'src\\cart\\total.ts', './src/cart/total.ts', 'src/./cart/total.ts', '..', '.'];
    for (const path of refused) {
      const answer = await call(port, 'GET', diffUrl(changeId, path));
      expect(answer.status, JSON.stringify(path)).toBe(400);
      expect(answer.text).not.toContain('export function');
    }
    // `:(glob)*` is no bad shape; membership says no, and git never sees it.
    const magic = await call(port, 'GET', diffUrl(changeId, ':(glob)*'));
    expect(magic.status).toBe(404);
    expect(errorCode(magic)).toBe('not-in-snapshot');
    expect(magic.text).not.toContain('export function');
    // A symbol with a NUL byte.
    expect((await call(port, 'GET', diffUrl(changeId, 'src/cart/total.ts', 'a\0b'))).status).toBe(400);
    // The path given twice.
    expect((await call(port, 'GET', `/api/changes/${String(changeId)}/diff?path=a&path=b`)).status).toBe(400);
  });
});

describe('api/diff-symlink-not-followed', () => {
  it('diffs a symlink as its target text and never reads what it points to', async () => {
    const repo = await sampleRepo();
    const secret = 'invented-secret-text-0042';
    const outside = join(repo.dir, '..', 'outside-secret.txt');
    await writeFile(outside, `${secret}\n`, 'utf8');
    scratches.push(outside);
    await symlink('../../../outside-secret.txt', join(repo.dir, 'src', 'link.ts'));
    // The same for a tracked file replaced by a link, and a link committed on the branch.
    await rm(join(repo.dir, 'src', 'link.ts'));
    await repo.git('checkout', '--quiet', '-b', 'feature/links');
    await symlink('../../outside-secret.txt', join(repo.dir, 'src', 'committed.ts'));
    await repo.commit('commit a link');
    await symlink('../../outside-secret.txt', join(repo.dir, 'src', 'link.ts'));
    await rm(join(repo.dir, 'src', 'cart', 'total.ts'));
    await symlink('../../../outside-secret.txt', join(repo.dir, 'src', 'cart', 'total.ts'));

    // The working tree is folded into the checked-out branch (ADR-019).
    const { port, changeId, report } = await collect(repo, 'branch:feature/links');
    const paths = report().packages.flatMap((p) => p.files).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['src/link.ts', 'src/committed.ts', 'src/cart/total.ts']));
    for (const path of ['src/link.ts', 'src/committed.ts', 'src/cart/total.ts']) {
      const answer = await call(port, 'GET', diffUrl(changeId, path));
      expect(answer.status, path).toBe(200);
      expect(answer.text, path).not.toContain(secret);
      const diff = answer.json() as FileDiff;
      expect(diff.kind, path).toBe('text');
      expect(diff.rows?.some((row) => row.text.includes('outside-secret.txt')), path).toBe(true);
    }
  });
});

describe('api/diff-cross-site-403', () => {
  it('refuses a request that a page on another site made, and serves the same request without browser headers or from the own page', async () => {
    const { port, changeId } = await draftWithTwoEdits();
    const url = diffUrl(changeId, 'src/cart/total.ts');
    const own = `http://127.0.0.1:${String(port)}`;
    const refused: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example' },
      { referer: 'https://evil.example/page' },
      { origin: own, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of refused) {
      const answer = await call(port, 'GET', url, { headers });
      expect(answer.status, JSON.stringify(headers)).toBe(403);
      expect(errorCode(answer)).toBe('forbidden');
      expect(answer.text).not.toContain('export function');
    }
    expect((await call(port, 'GET', url, { headers: {} })).status).toBe(200);
    expect((await call(port, 'GET', url, { headers: { origin: own, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    // The wrong Host is refused before the route (DNS rebinding).
    const rebound = await call(port, 'GET', url, { headers: { host: `evil.example:${String(port)}` } });
    expect(rebound.status).toBe(421);
  });
});

describe('api/diff-filters-not-run', () => {
  it('runs none of the commands a hostile repo names while computing a diff, in the working tree and in a commit', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'diffcity-diff-hostile-'));
    scratches.push(scratch);
    const markers = join(scratch, 'markers');
    await mkdir(markers);
    await mkdir(join(scratch, 'bin'));
    const script = async (name: string, behaviour: string): Promise<string> => {
      const path = join(scratch, 'bin', name);
      await writeFile(path, `#!/bin/sh\n: > "${join(markers, name)}"\n${behaviour}\n`, 'utf8');
      await chmod(path, 0o755);
      return path;
    };

    const repo = await sampleRepo();
    await repo.branch('feature/other');
    await repo.commit('sum', { 'src/cart/total.ts': body(0) });
    await repo.checkout('main');
    await repo.branch('feature/totals');
    await repo.commit('sum', { 'src/cart/total.ts': body(0) });
    await repo.write({ 'src/cart/tax.ts': TAX });

    const tamper = 'echo "export const tampered = true;"';
    const hooksDir = join(scratch, 'hooks');
    await mkdir(hooksDir);
    const hook = await script('hook', 'exit 0');
    for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout']) {
      await writeFile(join(hooksDir, name), `#!/bin/sh\nexec "${hook}"\n`, { encoding: 'utf8', mode: 0o755 });
    }
    await writeFile(
      join(repo.dir, '.git', 'config'),
      [
        `[filter "x"]\n\tclean = ${await script('filter-clean', tamper)}\n\tsmudge = ${await script('filter-smudge', tamper)}\n\tprocess = ${await script('filter-process', 'exit 1')}\n\trequired = true\n`,
        `[diff "x"]\n\ttextconv = ${await script('diff-textconv', tamper)}\n\tcommand = ${await script('diff-command', 'exit 0')}\n`,
        `[diff]\n\texternal = ${await script('diff-external', 'exit 0')}\n`,
        `[core]\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${hook}\n\tpager = ${hook}\n`,
      ].join(''),
      { encoding: 'utf8', flag: 'a' },
    );
    await writeFile(join(repo.dir, '.git', 'info', 'attributes'), '*.ts filter=x diff=x\n', 'utf8');
    expect(await readdir(markers)).toEqual([]);

    const draft = await collect(repo, 'branch:feature/totals');
    const files = draft.report().packages.flatMap((p) => p.files).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['src/cart/total.ts', 'src/cart/tax.ts']));
    for (const path of ['src/cart/total.ts', 'src/cart/tax.ts']) {
      const diff = (await call(draft.port, 'GET', diffUrl(draft.changeId, path))).json() as FileDiff;
      expect(diff.kind, path).toBe('text');
      expect(diff.rows?.map((row) => row.text).join('\n')).not.toContain('tampered');
    }
    const tax = (await call(draft.port, 'GET', diffUrl(draft.changeId, 'src/cart/tax.ts'))).json() as FileDiff;
    expect(tax.rows?.map((row) => row.text)).toContain('  return amount * 0.2;');
    expect(tax.stale).toBe(false);

    // A commit, through the clean branch change.
    const branch = draft.test.collection.db().changes.listLive(draft.repoId).find((c) => c.ref === 'branch:feature/other');
    if (branch === undefined) throw new Error('branch change missing');
    const committed = (await call(draft.port, 'GET', diffUrl(branch.id, 'src/cart/total.ts'))).json() as FileDiff;
    expect(committed.kind).toBe('text');
    expect(committed.rows?.some((row) => row.text.includes('a + b, 0'))).toBe(true);

    expect(await readdir(markers)).toEqual([]);
  });
});

describe('api/diff-pre-v2-snapshot-unavailable', () => {
  it('answers unavailable, with a reason, for a snapshot without merge-base and fingerprints, and 404 for a path outside its Report', async () => {
    const test = await startTestDaemon({}, { api: true });
    const db = test.collection.db();
    const repo = addRepo(db);
    const change = db.changes.applyPlan(repo.id, { create: [branchFields('totals')], update: [], archive: [] }, T0).created[0];
    if (change === undefined) throw new Error('no change');
    const report = {
      meta: { repo: 'sample-shop', base: 'main', head: change.head, commits: 1, generatedAt: T0 },
      packages: [{ id: 'src/cart', path: 'src/cart', tier1: false, files: [{ id: 'src/cart/total.ts', path: 'src/cart/total.ts', language: 'typescript', status: 'mod', verdict: 'ok', inSpec: null, symbols: [] }] }],
      steps: [],
      findings: [],
      summary: { files: 1, byStatus: { add: 0, mod: 1, sig: 0, del: 0, same: 0 }, byVerdict: { eyes: 0, risky: 0, spec: 0, ok: 1, same: 0 }, tier1Files: [] },
    };
    db.snapshots.put(snapshotInput(change.id, change.head, { report: JSON.stringify(report), mergeBase: null, fingerprints: null }));
    const port = test.daemon.info.port;

    const answer = await call(port, 'GET', diffUrl(change.id, 'src/cart/total.ts'));
    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({ kind: 'unavailable', path: 'src/cart/total.ts', language: 'typescript', stale: false, reason: expect.any(String) as string });
    expect((answer.json() as FileDiff).rows).toBeUndefined();
    expect(errorCode(await call(port, 'GET', diffUrl(change.id, 'src/other.ts')))).toBe('not-in-snapshot');
    // No snapshot at all.
    const bare = db.changes.applyPlan(repo.id, { create: [branchFields('bare')], update: [], archive: [] }, T0).created[0];
    expect(errorCode(await call(port, 'GET', diffUrl(bare?.id ?? 0, 'src/cart/total.ts')))).toBe('no-snapshot');
  });

  it('answers unavailable when the commits are gone from the repo', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/totals');
    await repo.commit('sum', { 'src/cart/total.ts': body(0) });
    await repo.checkout('main');
    const { test, port, changeId } = await collect(repo, 'branch:feature/totals');
    // Point the stored snapshot at a merge-base git does not have.
    const db = test.collection.db();
    const stored = db.snapshots.latest(changeId);
    if (stored === null) throw new Error('no snapshot');
    db.snapshots.put({ ...stored, mergeBase: '1234567890abcdef1234567890abcdef12345678' });
    const diff = (await call(port, 'GET', diffUrl(changeId, 'src/cart/total.ts'))).json() as FileDiff;
    expect(diff.kind).toBe('unavailable');
    expect(diff.reason).toBeDefined();
  });
});

describe('api/diff-not-stale-after-refresh', () => {
  it('drops the cached diff of a dirty change on a refreshed put: bytes changed under an identical Report', async () => {
    const repo = await sampleRepo();
    await repo.write({ 'src/cart/total.ts': body(0), 'src/cart/tax.ts': TAX });
    const { test, port, changeId } = await collect(repo, 'draft');
    const db = test.collection.db();
    const first = db.snapshots.latest(changeId);
    if (first === null) throw new Error('no snapshot');

    const total = (): Promise<FileDiff> => call(port, 'GET', diffUrl(changeId, 'src/cart/total.ts')).then((a) => a.json() as FileDiff);
    const tax = (): Promise<FileDiff> => call(port, 'GET', diffUrl(changeId, 'src/cart/tax.ts')).then((a) => a.json() as FileDiff);
    const added = (diff: FileDiff): string[] => (diff.rows ?? []).filter((row) => row.kind === 'add').map((row) => row.text);

    expect(await total()).toMatchObject({ stale: false });
    expect(added(await total()).join('\n')).toContain('a + b, 0');

    // Same-length edits that leave the Report as it was.
    await repo.write({ 'src/cart/total.ts': body(1), 'src/cart/tax.ts': TAX.replace('0.2', '0.3') });
    // Before the next snapshot, a file not yet looked at shows the change as stale.
    const early = await tax();
    expect(early.stale).toBe(true);
    expect(added(early).join('\n')).toContain('0.3');

    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    await waitFor(() => db.snapshots.latest(changeId)?.fingerprints !== first.fingerprints, 20_000, 'the refreshed fingerprints');
    await test.idle();
    expect(db.snapshots.latest(changeId)).toMatchObject({ id: first.id, contentHash: first.contentHash });

    const refreshed = await total();
    expect(refreshed.stale).toBe(false);
    expect(added(refreshed).join('\n')).toContain('a + b, 1');
    expect(added(refreshed).join('\n')).not.toContain('a + b, 0');
    expect((await tax()).stale).toBe(false);
  });
});

describe('api/diff-real-index-untouched', () => {
  it('leaves .git/index byte-identical and no temporary index directory behind, for an untracked file of a dirty change', async () => {
    const { port, changeId, repo } = await draftWithTwoEdits();
    const hash = async (): Promise<string> => createHash('sha256').update(await readFile(join(repo.dir, '.git', 'index'))).digest('hex');
    const tempIndexes = async (): Promise<string[]> => (await readdir(tmpdir())).filter((name) => name.startsWith('diffcity-index-'));
    // tax.ts is untracked, total.ts is a tracked edit.
    expect(await repo.status()).toContain('?? src/cart/tax.ts');
    const beforeHash = await hash();
    const beforeDirs = await tempIndexes();
    for (const path of ['src/cart/tax.ts', 'src/cart/total.ts']) {
      const answer = await call(port, 'GET', diffUrl(changeId, path));
      expect(answer.status, path).toBe(200);
      expect((answer.json() as FileDiff).kind, path).toBe('text');
    }
    expect(await hash()).toBe(beforeHash);
    expect(await repo.status()).toContain('?? src/cart/tax.ts');
    expect((await tempIndexes()).filter((name) => !beforeDirs.includes(name))).toEqual([]);
  });
});

describe('api/diff-cache-dropped-on-new-snapshot', () => {
  it('serves fresh content once a new snapshot of the change exists', async () => {
    const { test, port, changeId, repo } = await draftWithTwoEdits();
    const db = test.collection.db();
    const first = db.snapshots.latest(changeId);
    if (first === null) throw new Error('no snapshot');
    const added = async (): Promise<string> => {
      const diff = (await call(port, 'GET', diffUrl(changeId, 'src/cart/tax.ts'))).json() as FileDiff;
      return (diff.rows ?? []).filter((row) => row.kind === 'add').map((row) => row.text).join('\n');
    };
    expect(await added()).toContain('0.2');
    expect(await added()).toContain('0.2');

    // A new function changes the Report: the dirty snapshot of the same head is replaced (new contentHash), not just refreshed.
    await repo.write({ 'src/cart/tax.ts': `${TAX.replace('0.2', '0.5')}export function fee(): number {\n  return 1;\n}\n` });
    const again = await test.track(repo.dir);
    if (!again.ok) throw new Error(again.error);
    await waitFor(() => db.snapshots.latest(changeId)?.contentHash !== first.contentHash, 20_000, 'a replaced snapshot');
    await test.idle();

    const fresh = await added();
    expect(fresh).toContain('0.5');
    expect(fresh).toContain('fee');
    expect(fresh).not.toContain('0.2');
  });
});
