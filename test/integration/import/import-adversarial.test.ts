// `diffcity import` end to end and under adversarial input (ADR-036, SPEC.md
// sections 3a and 5.6): the CLI command (runImport) against an in-process
// daemon with the real collector and the JSON API. The full review loop
// (import own format and SARIF, served Report, intended, fixed, fix queue with
// no recollect), concurrent imports and collections, file encodings, the
// macOS /var spelling of the root, a subfolder, a linked worktree, the 4 MiB
// boundary, a `.diffcity` symlink and a nested `.diffcity/findings.json`.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runImport } from '../../../src/cli/import.js';
import type { FindingInput } from '../../../src/core/findings/index.js';
import { changedFiles, resolveChange } from '../../../src/core/git/index.js';
import type { SocketRequest } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { sendRequest } from '../../../src/daemon/client.js';
import { MAX_IMPORT_REQUEST_BYTES } from '../../../src/daemon/socket/protocol.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import type { TempRepo } from '../../helpers/repo.js';
import { call } from '../../helpers/review-api.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon, type TestDaemon } from '../collect/collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

type ImportRequest = Extract<SocketRequest, { type: 'import' }>;

const BALANCE = 'export function balance(entries: number[]): number {\n  return entries.reduce((a, b) => a + b, 0);\n}\n';
const AUDIT = 'export function audit(): string {\n  return "audited";\n}\n';

/** sample-shop on feature/ledger, one commit ahead of main with two changed files, checked out. */
async function ledgerRepo(): Promise<TempRepo> {
  const repo = await sampleRepo();
  await repo.branch('feature/ledger');
  await repo.commit('add the ledger', { 'src/ledger/balance.ts': BALANCE, 'src/ledger/audit.ts': AUDIT });
  return repo;
}

const own = (over: Partial<FindingInput> = {}): FindingInput => ({
  source: 'claude',
  severity: 'high',
  category: 'correctness',
  file: 'src/ledger/balance.ts',
  line: 2,
  title: 'Balance ignores refunds',
  message: 'Negative entries are summed without a check.',
  ...over,
});

function sarif(uri: string, line = 2): unknown {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: { driver: { name: 'semgrep', rules: [{ id: 'audit-literal' }] } },
        results: [
          {
            ruleId: 'audit-literal',
            level: 'error',
            message: { text: 'A literal audit result hides failures.' },
            locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
          },
        ],
      },
    ],
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `diffcity import <file>` from `cwd` against the test daemon (never starts one). */
async function cli(test: TestDaemon, file: string, cwd: string, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const result: CliResult = { code: -1, stdout: '', stderr: '' };
  result.code = await runImport(file, {}, {
    io: { stdout: (text) => (result.stdout += text), stderr: (text) => (result.stderr += text) },
    env: { ...test.home.env, PWD: cwd, ...env },
    cwd,
    spawnDaemon: () => {
      throw new Error('import must use the running test daemon');
    },
  });
  return result;
}

async function writeJson(dir: string, name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function liveChange(test: TestDaemon, ref: string): { id: number; repoId: number; dirty: boolean } {
  const change = test.collection
    .db()
    .repos.list()
    .flatMap((repo) => test.collection.db().changes.listLive(repo.id))
    .find((candidate) => candidate.ref === ref);
  if (change === undefined) throw new Error(`${ref} not collected`);
  return change;
}

async function servedReport(test: TestDaemon, changeId: number): Promise<Report> {
  const answer = await call(test.daemon.info.port, 'GET', `/api/changes/${String(changeId)}/report`);
  expect(answer.status).toBe(200);
  return answer.json() as Report;
}

const verdictOf = (report: Report, path: string): string | undefined =>
  report.packages.flatMap((pkg) => pkg.files).find((file) => file.path === path)?.verdict;

describe('diffcity import, the full loop (ADR-036)', () => {
  it('import/full-loop: own format and SARIF, served Report, intended kept, fixed on re-import, fix queue without a recollect', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
    const files = await mkdtemp(join(tmpdir(), 'dc-findings-'));
    try {
      // 1. Own format, one finding with an absolute path. The repo is unknown: import registers it.
      const ownFile = await writeJson(files, 'findings.json', [
        own(),
        own({ severity: 'med', category: 'style', file: join(repo.dir, 'src/ledger/audit.ts'), title: 'Magic string', message: 'Use a named constant.' }),
      ]);
      const first = await cli(test, ownFile, repo.dir);
      expect(first).toMatchObject({ code: 0, stderr: '' });
      expect(first.stdout).toBe('Imported 2 findings into feature/ledger (0 merged, 0 skipped, 0 fixed)\n');

      // 2. SARIF with a file:// URI.
      const sarifFile = await writeJson(files, 'scan.sarif.json', sarif(`file://${join(repo.dir, 'src/ledger/audit.ts')}`));
      const second = await cli(test, sarifFile, repo.dir);
      expect(second).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/ledger (0 merged, 0 skipped, 0 fixed)\n' });

      // 3. The served Report has the findings, anchored, and the risky verdicts.
      const change = liveChange(test, 'branch:feature/ledger');
      const report = await servedReport(test, change.id);
      expect(report.findings.map((finding) => [finding.source, finding.file, finding.symbolId, finding.state])).toEqual([
        ['claude', 'src/ledger/balance.ts', 'src/ledger/balance.ts#balance', 'open'],
        ['claude', 'src/ledger/audit.ts', 'src/ledger/audit.ts#audit', 'open'],
        ['semgrep', 'src/ledger/audit.ts', 'src/ledger/audit.ts#audit', 'open'],
      ]);
      expect(verdictOf(report, 'src/ledger/balance.ts')).toBe('risky');
      expect(verdictOf(report, 'src/ledger/audit.ts')).toBe('risky');
      const [balanceFinding, magicFinding, semgrepFinding] = report.findings;
      if (balanceFinding === undefined || magicFinding === undefined || semgrepFinding === undefined) throw new Error('findings missing');

      // 4. One is marked intended through the API.
      const marked = await call(test.daemon.info.port, 'PUT', `/api/changes/${String(change.id)}/findings/${magicFinding.id}/state`, { body: { state: 'intended' } });
      expect(marked.status).toBe(200);

      // 5. balance() changes and claude no longer reports it: fixed. The intended one stays intended.
      await repo.commit('skip refunds', { 'src/ledger/balance.ts': 'export function balance(entries: number[]): number {\n  return entries.filter((entry) => entry > 0).reduce((a, b) => a + b, 0);\n}\n' });
      const again = await writeJson(files, 'findings-2.json', [own({ severity: 'med', category: 'style', file: 'src/ledger/audit.ts', title: 'Magic string', message: 'Use a named constant.' })]);
      const third = await cli(test, again, repo.dir);
      expect(third).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/ledger (1 merged, 0 skipped, 1 fixed)\n' });
      const after = await servedReport(test, change.id);
      expect(Object.fromEntries(after.findings.map((finding) => [finding.id, finding.state]))).toEqual({
        [balanceFinding.id]: 'fixed',
        [magicFinding.id]: 'intended',
        [semgrepFinding.id]: 'open',
      });
      expect(verdictOf(after, 'src/ledger/balance.ts')).not.toBe('risky');
      await test.idle();

      // 6. Queue a fix: the file exists, and no snapshot, Draft or dirty flag follows.
      const db = test.collection.db();
      const settled = db.snapshots.latest(change.id);
      const queued = await call(test.daemon.info.port, 'POST', `/api/changes/${String(change.id)}/findings/${semgrepFinding.id}/fix`);
      expect(queued.status).toBe(200);
      expect(existsSync(join(repo.dir, '.diffcity', 'fix-queue.json'))).toBe(true);
      // Anything that asks for a collection now would find the queue file on disk.
      await test.track(repo.dir);
      await test.idle();
      expect(db.snapshots.latest(change.id)?.id).toBe(settled?.id);
      expect(db.changes.get(change.id)?.dirty).toBe(false);
      expect(db.changes.listLive(change.repoId).filter((candidate) => candidate.kind === 'draft')).toEqual([]);
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  });
});

describe('diffcity import, adversarial cases', () => {
  it('an import while the daemon is collecting the same change anchors to the new content', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    await repo.write({ 'src/ledger/fees.ts': 'export function fee(amount: number): number {\n  return amount * 0.02;\n}\n' });
    // A collection already running when the import arrives.
    const collecting = test.collection.collector().request(tracked.repo.id, 'full', 'high');
    const reply = await sendRequest(
      test.daemon.info.socket,
      { v: 1, type: 'import', dir: repo.dir, findings: [own({ file: 'src/ledger/fees.ts', title: 'Fee is hard-coded' })], warnings: [], sources: ['claude'], at: new Date().toISOString() },
      { timeoutMs: 40_000 },
    );
    await collecting;
    expect(reply).toMatchObject({ ok: true, imported: 1, skipped: 0, anchoredAgainst: 'current-snapshot' });
    if (!reply.ok) return;
    expect(test.collection.db().findings.list(reply.change.id).map((entry) => entry.finding.symbolId)).toEqual(['src/ledger/fees.ts#fee']);
    await test.idle();
  });

  it('two imports at once into the same change store each finding once', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const request = (findings: FindingInput[]): ImportRequest => ({ v: 1, type: 'import', dir: repo.dir, findings, warnings: [], sources: ['claude'], at: new Date().toISOString() });
    const shared = own();
    const [a, b] = await Promise.all([
      sendRequest(test.daemon.info.socket, request([shared, own({ file: 'src/ledger/audit.ts', title: 'Magic string' })]), { timeoutMs: 40_000 }),
      sendRequest(test.daemon.info.socket, request([shared]), { timeoutMs: 40_000 }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    if (!a.ok || !b.ok) return;
    expect(a.change.id).toBe(b.change.id);
    // The shared finding merged in whichever import came second.
    expect(a.merged + b.merged).toBe(1);
    const stored = test.collection.db().findings.list(a.change.id);
    expect(stored.map((entry) => entry.finding.title).sort()).toEqual(['Balance ignores refunds', 'Magic string']);
    expect(test.collection.db().events.listForRepo(tracked.repo.id).filter((event) => event.type === 'import')).toHaveLength(2);
    await test.idle();
  });

  it('a findings file with a byte order mark and CRLF line ends is read; a UTF-16 file is refused with exit 1', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const files = await mkdtemp(join(tmpdir(), 'dc-findings-'));
    try {
      const text = JSON.stringify([own()], null, 2).replace(/\n/g, '\r\n');
      const bom = join(files, 'bom.json');
      await writeFile(bom, `\uFEFF${text}\r\n`, 'utf8');
      expect(await cli(test, bom, repo.dir)).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/ledger (0 merged, 0 skipped, 0 fixed)\n', stderr: '' });

      const sarifCrlf = join(files, 'scan.sarif.json');
      await writeFile(sarifCrlf, JSON.stringify(sarif('src/ledger/audit.ts'), null, 2).replace(/\n/g, '\r\n'));
      expect(await cli(test, sarifCrlf, repo.dir)).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/ledger (0 merged, 0 skipped, 0 fixed)\n' });

      const utf16 = join(files, 'utf16.json');
      await writeFile(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
      const refused = await cli(test, utf16, repo.dir);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toMatch(/^diffcity import: .*utf16\.json is not a valid findings file:\n {2}the file is not valid JSON/);
      await test.idle();
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  });

  it('SARIF absolute paths in the /var spelling and the /private/var realpath both anchor (macOS)', async () => {
    const repo = await ledgerRepo();
    const real = await realpath(repo.dir);
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const files = await mkdtemp(join(tmpdir(), 'dc-findings-'));
    try {
      const logical = await writeJson(files, 'logical.sarif.json', sarif(`file://${join(repo.dir, 'src/ledger/audit.ts')}`));
      const physical = await writeJson(files, 'physical.sarif.json', sarif(`file://${join(real, 'src/ledger/balance.ts')}`));
      expect(await cli(test, logical, repo.dir)).toMatchObject({ code: 0, stderr: '', stdout: expect.stringMatching(/^Imported 1 finding .*0 skipped/) as unknown });
      expect(await cli(test, physical, repo.dir)).toMatchObject({ code: 0, stderr: '', stdout: expect.stringMatching(/^Imported 1 finding .*0 skipped/) as unknown });
      // From the physical cwd with no logical $PWD, the realpath spelling still works.
      expect(await cli(test, physical, real, { PWD: real })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Imported 1 finding .*1 merged/) as unknown });
      const change = liveChange(test, 'branch:feature/ledger');
      expect(test.collection.db().findings.list(change.id).map((entry) => entry.finding.file).sort()).toEqual(['src/ledger/audit.ts', 'src/ledger/balance.ts']);
      await test.idle();
    } finally {
      await rm(files, { recursive: true, force: true });
    }
  });

  it('an import from a subfolder of the repo goes to the change, with a relative file argument', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    await repo.write({ 'src/ledger/review.json': JSON.stringify([own()]) });
    const result = await cli(test, 'review.json', join(repo.dir, 'src', 'ledger'));
    // review.json is untracked: the branch is dirty, and still the change the import goes to.
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: 'Imported 1 finding into feature/ledger (0 merged, 0 skipped, 0 fixed)\n' });
    const change = liveChange(test, 'branch:feature/ledger');
    expect(test.collection.db().findings.list(change.id).map((entry) => entry.finding.symbolId)).toEqual(['src/ledger/balance.ts#balance']);
    await test.idle();
  });

  it('an import from a linked git worktree goes to the branch checked out there', async () => {
    const repo = await ledgerRepo();
    const linkedParent = await mkdtemp(join(tmpdir(), 'dc-linked-'));
    const linked = join(linkedParent, 'sample-shop-fees');
    try {
      await repo.git('worktree', 'add', '-b', 'feature/fees', linked, 'main');
      await writeFile(join(linked, 'fees.ts'), 'export function fee(amount: number): number {\n  return amount * 0.02;\n}\n');
      const test = await startTestDaemon({ gh: ghNotInstalled() });
      // Registered from the main working tree first: the linked one is found through it.
      const tracked = await test.track(repo.dir);
      if (!tracked.ok) throw new Error(tracked.error);
      await test.idle();
      const findings = await writeJson(linkedParent, 'findings.json', [own({ file: 'fees.ts', title: 'Fee is hard-coded' })]);
      const result = await cli(test, findings, linked);
      expect(result.code).toBe(0);
      // feature/fees is at main's head with an untracked file: the import goes to that working tree's Draft (ADR-019).
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toMatch(/^Imported 1 finding into the Draft in \S*\/sample-shop-fees \(0 merged, 0 skipped, 0 fixed\)\n$/);
      const changes = test.collection.db().changes.listLive(tracked.repo.id);
      const target = changes.find((change) => test.collection.db().findings.list(change.id).length > 0);
      expect(target?.kind).toBe('draft');
      expect(test.collection.db().findings.list(target?.id ?? -1).map((entry) => entry.finding.symbolId)).toEqual(['fees.ts#fee']);
      expect(test.collection.db().findings.list(liveChange(test, 'branch:feature/ledger').id)).toEqual([]);
      await test.idle();
    } finally {
      await repo.git('worktree', 'remove', '--force', linked).catch(() => '');
      await rm(linkedParent, { recursive: true, force: true });
    }
  });

  it('an import line of exactly 4 MiB is accepted; one byte more is refused', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const tracked = await test.track(repo.dir);
    if (!tracked.ok) throw new Error(tracked.error);
    await test.idle();
    const at = new Date().toISOString();
    const sized = (target: number): ImportRequest => {
      const findings: FindingInput[] = [];
      const request: ImportRequest = { v: 1, type: 'import', dir: repo.dir, findings, warnings: [], sources: ['claude'], at };
      const size = (): number => Buffer.byteLength(JSON.stringify(request), 'utf8');
      for (let index = 0; size() < target; index++) {
        const finding = own({ title: `Invented finding ${String(index)}`, message: 'm' });
        findings.push(finding);
        const room = target - size();
        if (room < 0) {
          findings.pop();
          // Pad the previous finding up to the target.
          const last = findings[findings.length - 1];
          if (last === undefined) throw new Error('target too small');
          last.message += 'm'.repeat(target - size());
          break;
        }
        finding.message += 'm'.repeat(Math.min(room, 16 * 1024 - 1));
      }
      expect(size()).toBe(target);
      return request;
    };
    const exact = sized(MAX_IMPORT_REQUEST_BYTES);
    const accepted = await sendRequest(test.daemon.info.socket, exact, { timeoutMs: 40_000 });
    expect(accepted).toMatchObject({ ok: true, imported: exact.findings.length });
    const over = await sendRequest(test.daemon.info.socket, sized(MAX_IMPORT_REQUEST_BYTES + 1), { timeoutMs: 40_000 });
    expect(over).toEqual({ ok: false, error: `request exceeds ${String(MAX_IMPORT_REQUEST_BYTES)} bytes` });
    expect(await sendRequest(test.daemon.info.socket, { v: 1, type: 'ping' })).toMatchObject({ ok: true });
    await test.idle();
  });

  it('a .diffcity symlink is not followed: it is a normal touched file, and the fix queue refuses to write through it', async () => {
    const repo = await ledgerRepo();
    const outside = await mkdtemp(join(tmpdir(), 'dc-outside-'));
    try {
      await writeFile(join(outside, 'findings.json'), '[]\n');
      await writeFile(join(outside, 'fix-queue.json'), '{"version":1,"items":[]}\n');
      await symlink(outside, join(repo.dir, '.diffcity'));
      const change = await resolveChange(repo.dir, { base: 'main' });
      expect((await changedFiles(change)).map((file) => file.path)).toEqual(['.diffcity', 'src/ledger/audit.ts', 'src/ledger/balance.ts']);

      const test = await startTestDaemon({ gh: ghNotInstalled() }, { api: true });
      // The import itself reads through the link: it is just the file the user named.
      await writeJson(outside, 'review.json', [own()]);
      const result = await cli(test, join(repo.dir, '.diffcity', 'review.json'), repo.dir);
      expect(result).toMatchObject({ code: 0, stderr: '', stdout: 'Imported 1 finding into feature/ledger (0 merged, 0 skipped, 0 fixed)\n' });
      const live = liveChange(test, 'branch:feature/ledger');
      expect(live.dirty).toBe(true);
      const [stored] = test.collection.db().findings.list(live.id);
      if (stored === undefined) throw new Error('finding not stored');
      const queued = await call(test.daemon.info.port, 'POST', `/api/changes/${String(live.id)}/findings/${stored.key}/fix`);
      expect(queued.status).toBe(409);
      expect(queued.json()).toMatchObject({ error: { code: 'fix-queue-unsafe' } });
      expect(await readFile(join(outside, 'fix-queue.json'), 'utf8')).toBe('{"version":1,"items":[]}\n');
      await test.idle();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('sub/.diffcity/findings.json is a normal file: touched, and it makes the tree dirty', async () => {
    const repo = await ledgerRepo();
    const test = await startTestDaemon({ gh: ghNotInstalled() });
    await repo.write({ 'sub/.diffcity/findings.json': JSON.stringify([own()]), '.diffcity/findings.json': JSON.stringify([own()]) });
    const change = await resolveChange(repo.dir, { base: 'main' });
    expect((await changedFiles(change)).map((file) => file.path)).toEqual(['src/ledger/audit.ts', 'src/ledger/balance.ts', 'sub/.diffcity/findings.json']);
    const result = await cli(test, 'sub/.diffcity/findings.json', repo.dir);
    expect(result.code).toBe(0);
    const live = liveChange(test, 'branch:feature/ledger');
    expect(live.dirty).toBe(true);
    const snapshot = test.collection.db().snapshots.latest(live.id);
    const report = JSON.parse(snapshot?.report ?? '{}') as Report;
    expect(report.packages.flatMap((pkg) => pkg.files.map((file) => file.path))).toContain('sub/.diffcity/findings.json');
    expect(report.packages.flatMap((pkg) => pkg.files.map((file) => file.path))).not.toContain('.diffcity/findings.json');
    await test.idle();
  });
});
