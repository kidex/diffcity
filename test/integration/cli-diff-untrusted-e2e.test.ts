// End-to-end check of DC-37 through the built CLI (dist/, built by
// test/global-setup.ts): `diffcity diff --json` run from inside a hostile repo
// that points every command git could take from the repo at a marker script,
// all at once. The run must exit 0, produce the same report as the unarmed
// repo, and leave no marker behind. A benign repo that selects a filter the
// user defines in their own global config still gets that filter applied.
//
// git runs with a temp HOME (its ~/.gitconfig is the "global" config here) and
// no system config; the machine's real global git config is never read or written.

import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { File, Report } from '../../src/core/report/types.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

const cliEntry = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

/** Every hook name git knows (githooks(5)), so whichever one a code path would fire is armed. */
const HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
];

const PRICING_BEFORE = 'export function applyDiscount(total: number): number {\n  return total * 0.9;\n}\n';
const PRICING_AFTER = 'export function applyDiscount(total: number, rate: number): number {\n  return total * (1 - rate);\n}\n';
const UTIL = 'export function pad(text: string): string {\n  return ` ${text} `;\n}\n';
const FRESH = 'export function wave(): string {\n  return "o/";\n}\n';
const TAMPER = 'echo "export const tampered = true;"';

let scratch: string;
let home: string;
let diffcityHome: string;
let markers: string;
let fakeBin: string;
const repos: TempRepo[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'diffcity-hostile-e2e-'));
  home = join(scratch, 'home');
  diffcityHome = join(scratch, 'diffcity-home');
  markers = join(scratch, 'markers');
  fakeBin = join(scratch, 'fake-bin');
  for (const dir of [home, diffcityHome, markers, fakeBin, join(scratch, 'bin')]) await mkdir(dir);
  // A `gh` on PATH that only leaves a marker: no real gh (or network) is ever reached.
  await writeFile(join(fakeBin, 'gh'), `#!/bin/sh\n: > "${join(markers, 'gh')}"\nexit 1\n`, { encoding: 'utf8', mode: 0o755 });
});

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

/** A script that records `name` in the markers directory, then runs `behaviour`. */
async function markerScript(name: string, behaviour: string): Promise<string> {
  const path = join(scratch, 'bin', name);
  await writeFile(path, `#!/bin/sh\n: > "${join(markers, name)}"\n${behaviour}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

/**
 * Like markerScript, but returns a command that runs the script through `sh`. Used for the
 * commands that really run (the user's own filters): git runs a filter once per file, and on
 * macOS each direct exec of a freshly written file pays a slow provenance check.
 */
async function shMarkerScript(name: string, behaviour: string): Promise<string> {
  const path = await markerScript(name, behaviour);
  return `sh '${path.replaceAll("'", "'\\''")}'`;
}

async function markersSeen(): Promise<string[]> {
  return (await readdir(markers)).sort();
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI in `cwd` as a user would, with the temp HOME and no inherited GIT_* variables. */
function runCli(cwd: string, args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DIFFCITY_HOME: diffcityHome,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
  });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliEntry, ...args], { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== 'number') {
        reject(new Error(`could not run the CLI: ${error.message}`, { cause: error }));
        return;
      }
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

function fileMap(report: Report): Map<string, File> {
  return new Map(report.packages.flatMap((pkg) => pkg.files).map((file) => [file.path, file]));
}

function withoutTimestamp(report: Report): Report {
  return { ...report, meta: { ...report.meta, generatedAt: '' } };
}

/** Gives the tracked files a future mtime, so git cannot trust the index and must hash them. */
async function statDirty(dir: string, paths: string[]): Promise<void> {
  const future = new Date(Date.now() + 60_000);
  for (const path of paths) await utimes(join(dir, path), future, future);
}

/**
 * main: src/lib/pricing.ts, src/util.ts. feature/discounts: a parameter added to
 * applyDiscount and a submodule vendor/lib. Uncommitted: pricing.ts and util.ts
 * stat-dirty with unchanged bytes, src/fresh.ts untracked, the submodule dirty.
 */
async function hostileRepo(): Promise<TempRepo> {
  const lib = await createRepo({ name: 'sample-lib', files: { 'src/pad.ts': UTIL } });
  repos.push(lib);
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/lib/pricing.ts': PRICING_BEFORE, 'src/util.ts': UTIL },
  });
  repos.push(repo);
  await repo.branch('feature/discounts');
  await repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib.dir, 'vendor/lib');
  await repo.commit('discounts', { 'src/lib/pricing.ts': PRICING_AFTER });

  await repo.write({ 'src/fresh.ts': FRESH });
  await writeFile(join(repo.dir, 'vendor/lib/src/extra.ts'), FRESH, 'utf8');
  await statDirty(repo.dir, ['src/lib/pricing.ts', 'src/util.ts', 'vendor/lib/src/pad.ts']);
  return repo;
}

/** Points every command git can take from the repo (and from its submodule) at a marker script. */
async function armRepo(repo: TempRepo): Promise<void> {
  const clean = await markerScript('filter-clean', TAMPER);
  const smudge = await markerScript('filter-smudge', TAMPER);
  const process = await markerScript('filter-process', 'exit 1');
  const included = await markerScript('filter-included-clean', TAMPER);
  const textconv = await markerScript('diff-textconv', TAMPER);
  const driver = await markerScript('diff-command', 'exit 0');
  const external = await markerScript('diff-external', 'exit 0');
  const fsmonitor = await markerScript('core-fsmonitor', 'exit 0');
  const pager = await markerScript('core-pager', 'cat');
  const sshCommand = await markerScript('core-sshcommand', 'exit 1');
  const askPass = await markerScript('core-askpass', 'exit 1');
  const credential = await markerScript('credential-helper', 'exit 1');
  const transport = await markerScript('ext-transport', 'exit 1');
  const uploadPack = await markerScript('remote-uploadpack', 'exit 1');
  const subClean = await markerScript('submodule-filter-clean', TAMPER);
  const subFsmonitor = await markerScript('submodule-fsmonitor', 'exit 0');

  const hooksDir = join(scratch, 'hooks');
  await mkdir(hooksDir);
  const defaultHooksDir = join(repo.dir, '.git', 'hooks');
  await mkdir(defaultHooksDir, { recursive: true });
  for (const name of HOOK_NAMES) {
    for (const [dir, label] of [
      [hooksDir, 'hookspath'],
      [defaultHooksDir, 'default'],
    ] as const) {
      await writeFile(join(dir, name), `#!/bin/sh\n: > "${join(markers, `hook-${label}-${name}`)}"\nexit 0\n`, {
        encoding: 'utf8',
        mode: 0o755,
      });
    }
  }

  // A config file the repo pulls in through include.path.
  const includedConfig = join(scratch, 'included.gitconfig');
  await writeFile(includedConfig, `[filter "inc"]\n\tclean = ${included}\n\trequired = true\n`, 'utf8');

  await appendFile(
    join(repo.dir, '.git', 'config'),
    [
      `[include]\n\tpath = ${includedConfig}\n`,
      `[filter "x"]\n\tclean = ${clean}\n\tsmudge = ${smudge}\n\trequired = true\n`,
      `[filter "p"]\n\tprocess = ${process}\n\trequired = true\n`,
      `[diff "x"]\n\ttextconv = ${textconv}\n\tcommand = ${driver}\n`,
      `[diff]\n\texternal = ${external}\n`,
      `[core]\n\trepositoryformatversion = 1\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${fsmonitor}\n`,
      `\tpager = ${pager}\n\tsshCommand = ${sshCommand}\n\taskPass = ${askPass}\n`,
      `[credential]\n\thelper = ${credential}\n`,
      `[protocol]\n\tallow = always\n`,
      `[protocol "ext"]\n\tallow = always\n`,
      `[protocol "file"]\n\tallow = always\n`,
      `[extensions]\n\tpartialClone = origin\n`,
      `[remote "origin"]\n\turl = ext::${transport} %S\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      `\tpromisor = true\n\tpartialclonefilter = blob:none\n\tuploadpack = ${uploadPack}\n`,
      `[fetch]\n\trecurseSubmodules = true\n`,
    ].join(''),
    'utf8',
  );
  await writeFile(
    join(repo.dir, '.git', 'info', 'attributes'),
    '*.ts filter=x diff=x\nsrc/lib/*.ts filter=p diff=x\nsrc/util.ts filter=inc diff=x\n',
    'utf8',
  );

  // The submodule's own config and attributes select a filter of its own.
  await repo.git('-C', 'vendor/lib', 'config', 'filter.x.clean', subClean);
  await repo.git('-C', 'vendor/lib', 'config', 'filter.x.required', 'true');
  await repo.git('-C', 'vendor/lib', 'config', 'core.fsmonitor', subFsmonitor);
  const subAttributes = await repo.git(
    '-C',
    'vendor/lib',
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'info/attributes',
  );
  await mkdir(join(subAttributes, '..'), { recursive: true });
  await writeFile(subAttributes, '*.ts filter=x\n', 'utf8');

  // Arming rewrote nothing in the working tree, but keep every tracked file stat-dirty.
  await statDirty(repo.dir, ['src/lib/pricing.ts', 'src/util.ts', 'vendor/lib/src/pad.ts']);
}

describe('e2e: diffcity diff --json in a hostile repo (DC-37)', () => {
  it(
    'exits 0 with the same report as the unarmed repo and runs none of the repo commands',
    { timeout: 120_000 },
    async () => {
      const repo = await hostileRepo();

      const baseline = await runCli(repo.dir, ['diff', '--json']);
      expect(baseline.stderr).toBe('');
      expect(baseline.code).toBe(0);
      const expected = JSON.parse(baseline.stdout) as Report;

      await armRepo(repo);
      expect(await markersSeen()).toEqual([]);

      const result = await runCli(repo.dir, ['diff', '--json']);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as Report;

      // Nothing the repo configures ran: no filter, textconv, external diff, hook,
      // fsmonitor, pager, transport, credential helper, and nothing in the submodule.
      expect(await markersSeen()).toEqual([]);

      expect(withoutTimestamp(report)).toEqual(withoutTimestamp(expected));
      expect(report.meta).toMatchObject({ repo: 'sample-shop', base: 'main', head: 'feature/discounts', commits: 1 });
      const files = fileMap(report);
      expect(Object.fromEntries([...files].map(([path, file]) => [path, file.status]))).toEqual({
        '.gitmodules': 'add',
        'src/fresh.ts': 'add',
        'src/lib/pricing.ts': 'sig',
        'src/util.ts': 'same',
      });
      const pricing = files.get('src/lib/pricing.ts');
      expect(pricing?.symbols.map((s) => [s.id, s.status])).toEqual([['src/lib/pricing.ts#applyDiscount', 'sig']]);
      expect(pricing?.symbols[0]?.signatureAfter).toBe('function applyDiscount(total: number, rate: number): number');
      expect(files.get('src/fresh.ts')?.symbols.map((s) => s.id)).toEqual(['src/fresh.ts#wave']);
      expect(JSON.stringify(report)).not.toContain('tampered');
      expect(await readdir(diffcityHome)).toEqual([]);
    },
  );
});

describe('e2e: a benign repo selecting a filter from the user global config', () => {
  /**
   * The repo commits `*.ts filter=user`; the user's ~/.gitconfig (in the temp HOME)
   * defines filter.user.clean, which drops lines tagged `local-only`. A tagged
   * line added to util.ts in the working tree is therefore invisible to git.
   */
  async function benignRepo(): Promise<TempRepo> {
    const repo = await createRepo({
      name: 'sample-blog',
      files: { '.gitattributes': '*.ts filter=user\n', 'src/lib/pricing.ts': PRICING_BEFORE, 'src/util.ts': UTIL },
    });
    repos.push(repo);
    await repo.branch('feature/discounts');
    await repo.commit('discounts', { 'src/lib/pricing.ts': PRICING_AFTER });
    await repo.write({ 'src/util.ts': `${UTIL}export const localOnly = 1; // local-only\n` });
    return repo;
  }

  it('applies the user filter: its marker runs and the filtered line is not a change', { timeout: 120_000 }, async () => {
    const repo = await benignRepo();
    const userClean = await shMarkerScript('user-clean', "sed '/local-only/d'");
    await writeFile(join(home, '.gitconfig'), `[filter "user"]\n\tclean = ${userClean}\n\trequired = true\n`, 'utf8');

    const result = await runCli(repo.dir, ['diff', '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;

    expect(await markersSeen()).toEqual(['user-clean']);
    const files = fileMap(report);
    expect(files.get('src/lib/pricing.ts')?.status).toBe('sig');
    expect(files.get('src/util.ts')?.status ?? 'same').toBe('same');
    expect(report.summary.byStatus.add).toBe(0);
  });

  it('control: without the user filter the same working tree shows util.ts as changed', { timeout: 120_000 }, async () => {
    const repo = await benignRepo();

    const result = await runCli(repo.dir, ['diff', '--json']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;

    expect(await markersSeen()).toEqual([]);
    expect(fileMap(report).get('src/util.ts')?.status).not.toBe('same');
    expect(fileMap(report).get('src/util.ts')?.status).toBeDefined();
  });
});
