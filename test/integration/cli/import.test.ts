// `diffcity import <file> [--open]` (SPEC.md sections 3 and 5.6, ADR-036)
// against a fake daemon that speaks socket protocol v1. The real daemon's
// import handler is covered by test/integration/import.

import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OLD_DAEMON_MESSAGE, runImport, type ImportDeps } from '../../../src/cli/import.js';
import { homePaths, ensureHome, type HomePaths } from '../../../src/core/home.js';
import { readVersion } from '../../../src/core/version.js';
import { writeDaemonInfo } from '../../../src/daemon/files.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { fakeSpawner, startFakeDaemon, type FakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

isolateGitConfig();

let temp: TempHome;
let paths: HomePaths;
let repo: TempRepo;
const fakes: FakeDaemon[] = [];
const servers: Server[] = [];

beforeEach(async () => {
  temp = await tempHome();
  paths = homePaths(temp.home);
  repo = await createRepo({ name: 'sample-shop', files: { 'src/cart/total.ts': 'export const total = 1;\n' } });
});
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await repo.cleanup();
  await temp.cleanup();
});

const AT = new Date('2026-03-04T05:06:07.000Z');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  opened: string[];
}

const noSpawn: NonNullable<ImportDeps['spawnDaemon']> = () => {
  throw new Error('import must not start a daemon here');
};

async function run(file: string, options: { open?: boolean } = {}, deps: Partial<ImportDeps> = {}): Promise<Result> {
  const result: Result = { code: -1, stdout: '', stderr: '', opened: [] };
  result.code = await runImport(file, options, {
    io: { stdout: (text) => (result.stdout += text), stderr: (text) => (result.stderr += text) },
    env: temp.env,
    cwd: repo.dir,
    now: () => AT,
    spawnDaemon: noSpawn,
    openUrl: (url) => {
      result.opened.push(url);
      return Promise.resolve(true);
    },
    ...deps,
  });
  return result;
}

async function running(handlers?: Parameters<typeof startFakeDaemon>[1]): Promise<FakeDaemon> {
  const fake = await startFakeDaemon(paths, handlers);
  fakes.push(fake);
  return fake;
}

const OWN = [
  {
    source: 'claude',
    severity: 'high',
    category: 'correctness',
    file: 'src/cart/total.ts',
    line: 1,
    title: 'Total is a constant',
    message: 'The total never depends on the items.',
  },
  { source: 'claude', severity: 'low', category: 'style', file: '../outside.ts', line: 1, title: 'Outside', message: 'Not in the repo.' },
];

describe('diffcity import', () => {
  it('cli/import-own-format: parses the own format and sends findings, warnings and sources for the current directory', async () => {
    const fake = await running();
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN));
    const result = await run('findings.json');
    expect(result).toEqual({
      code: 0,
      stdout: 'Imported 1 finding into feature/totals (0 merged, 1 skipped, 0 fixed)\n',
      stderr: 'warning: findings[1]: skipped: path "../outside.ts" contains ".."\n',
      opened: [],
    });
    expect(fake.requests).toEqual([
      {
        v: 1,
        type: 'import',
        dir: repo.dir,
        findings: [{ source: 'claude', severity: 'high', category: 'correctness', file: 'src/cart/total.ts', line: 1, title: 'Total is a constant', message: 'The total never depends on the items.' }],
        warnings: [{ at: 'findings[1]', message: 'skipped: path "../outside.ts" contains ".."' }],
        sources: ['claude'],
        at: AT.toISOString(),
      },
    ]);
  });

  it('cli/import-sarif: detects SARIF and sends every run with results as a covered source', async () => {
    const fake = await running();
    const sarif = {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'semgrep' } },
          results: [
            {
              ruleId: 'sample-shop.constant-total',
              level: 'warning',
              message: { text: 'The total is a constant.' },
              locations: [{ physicalLocation: { artifactLocation: { uri: `file://${repo.dir}/src/cart/total.ts` }, region: { startLine: 1 } } }],
            },
          ],
        },
        { tool: { driver: { name: 'eslint' } }, results: [] },
      ],
    };
    await writeFile(join(repo.dir, 'scan.sarif.json'), JSON.stringify(sarif));
    const result = await run('scan.sarif.json');
    expect(result).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/totals (0 merged, 0 skipped, 0 fixed)\n', stderr: '' });
    expect(fake.requests).toEqual([
      expect.objectContaining({
        type: 'import',
        findings: [expect.objectContaining({ source: 'semgrep', severity: 'med', file: 'src/cart/total.ts', line: 1, title: 'sample-shop.constant-total' })],
        sources: ['semgrep', 'eslint'],
      }),
    ]);
  });

  it('cli/import-open-flag: --open opens the change route of the running daemon, like start opens its URL', async () => {
    await running();
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN.slice(0, 1)));
    const result = await run('findings.json', { open: true });
    expect(result).toEqual({
      code: 0,
      stdout: 'Imported 1 finding into feature/totals (0 merged, 0 skipped, 0 fixed)\nhttp://127.0.0.1:4999/#/change/12\n',
      stderr: '',
      opened: ['http://127.0.0.1:4999/#/change/12'],
    });
    const failedOpen = await run('findings.json', { open: true }, { openUrl: () => Promise.resolve(false) });
    expect(failedOpen.stderr).toBe('could not open a browser; open http://127.0.0.1:4999/#/change/12 yourself\n');
    expect(failedOpen.code).toBe(0);
  });

  it('cli/import-invalid-file-exit-1: an invalid file exits 1 with the reasons and sends nothing', async () => {
    const fake = await running();
    await writeFile(join(repo.dir, 'broken.json'), '{ not json');
    const broken = await run('broken.json');
    expect(broken.code).toBe(1);
    expect(broken.stderr).toMatch(/^diffcity import: broken\.json is not a valid findings file:\n {2}the file is not valid JSON/);

    await writeFile(join(repo.dir, 'bad.json'), JSON.stringify([{ ...OWN[0], severity: 'urgent', line: 0 }]));
    const bad = await run('bad.json');
    expect(bad).toMatchObject({ code: 1, stdout: '' });
    expect(bad.stderr).toContain('findings[0].severity: must be one of high, med, low');
    expect(bad.stderr).toContain('findings[0].line: must be an integer of 1 or more');

    const missing = await run('nowhere.json');
    expect(missing).toMatchObject({ code: 1, stdout: '' });
    expect(missing.stderr).toMatch(/^diffcity import: cannot read .*nowhere\.json/);
    expect(fake.requests).toEqual([]);
  });

  it('a file over 8 MiB is refused before it is parsed', async () => {
    const fake = await running();
    await writeFile(join(repo.dir, 'huge.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const result = await run('huge.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/huge\.json is 8388609 bytes; a findings file may be at most 8 MiB/);
    expect(fake.requests).toEqual([]);
  });

  it('parsed findings over 4 MiB are refused before they are sent', async () => {
    const fake = await running();
    const many = Array.from({ length: 5000 }, (_, index) => ({ ...OWN[0], title: `Finding ${String(index)}`, message: 'm'.repeat(900) }));
    await writeFile(join(repo.dir, 'many.json'), JSON.stringify(many));
    const result = await run('many.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/over the 4 MiB an import may carry; split the file/);
    expect(fake.requests).toEqual([]);
  });

  it('a daemon refusal exits 1 with its reason', async () => {
    await running({ import: () => ({ ok: false, error: 'no change is checked out in /work/sample-shop: nothing differs from the base' }) });
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN.slice(0, 1)));
    expect(await run('findings.json')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'diffcity import: no change is checked out in /work/sample-shop: nothing differs from the base\n',
      opened: [],
    });
  });

  it('says when the findings were anchored to the previous snapshot', async () => {
    await running({
      import: (request) => ({
        ok: true,
        change: { id: 4, repoId: 1, ref: 'pr:17' },
        imported: request.findings.length,
        merged: 2,
        skipped: 1,
        fixed: 3,
        warnings: [],
        anchoredAgainst: 'previous-snapshot',
      }),
    });
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN.slice(0, 1)));
    expect((await run('findings.json')).stdout).toBe(
      'Imported 1 finding into PR #17 (2 merged, 1 skipped, 3 fixed)\nThe change was still being collected: the findings are anchored to its previous snapshot.\n',
    );
  });

  it('import/old-daemon-unknown-type: a daemon that does not know import gets the restart hint', async () => {
    await ensureHome(paths.home);
    const old = createServer((socket) => {
      socket.setEncoding('utf8');
      let line = '';
      socket.on('data', (chunk: string) => {
        line += chunk;
        if (!line.includes('\n')) return;
        const request = JSON.parse(line.slice(0, line.indexOf('\n'))) as { type: string };
        const reply = request.type === 'ping' ? { ok: true, version: readVersion(), pid: process.pid, port: 4999 } : { ok: false, error: `unknown request type: ${request.type}` };
        socket.end(`${JSON.stringify(reply)}\n`);
      });
    });
    servers.push(old);
    await new Promise<void>((resolve) => old.listen(paths.socket, resolve));
    await writeDaemonInfo(paths, { pid: process.pid, port: 4999, socket: paths.socket, version: readVersion(), startedAt: AT.toISOString() });
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN.slice(0, 1)));
    expect(await run('findings.json')).toEqual({ code: 1, stdout: '', stderr: `diffcity import: ${OLD_DAEMON_MESSAGE}\n`, opened: [] });
    expect(OLD_DAEMON_MESSAGE).toBe('the running daemon is older than this CLI; run `diffcity stop` then try again');
  });

  it('starts the daemon when none runs, like start does', async () => {
    const spawner = fakeSpawner();
    await writeFile(join(repo.dir, 'findings.json'), JSON.stringify(OWN.slice(0, 1)));
    const result = await run('findings.json', {}, { spawnDaemon: spawner.spawn, isPortFree: () => Promise.resolve(true) });
    fakes.push(await spawner.started());
    expect(result).toMatchObject({ code: 0, stdout: 'Imported 1 finding into feature/totals (0 merged, 0 skipped, 0 fixed)\n' });
    expect(spawner.calls).toHaveLength(1);
  });

  it('outside a git repository: exit 1, nothing read, no daemon started', async () => {
    const result = await run('findings.json', {}, { cwd: temp.userHome });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^diffcity import: not a git repository/);
  });
});
