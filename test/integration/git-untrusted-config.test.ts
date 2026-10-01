// A repo's own config and .gitattributes can name commands git would run while
// diffcity reads the repo: filter drivers, textconv, external diff, hooks and the
// transport of a lazy fetch. None of them may ever run (DC-37).

import { chmod, mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitError,
  changedFiles,
  computeMeta,
  listHeadFiles,
  readAfter,
  readAfterBatch,
  readBefore,
  resolveChange,
  type ResolvedChange,
} from '../../src/core/git/index.js';
import { gitRaw } from '../../src/core/git/exec.js';
import { buildReport } from '../../src/core/report/build.js';
import type { Report } from '../../src/core/report/types.js';
import { ghForbidden, isolateGitConfig } from '../helpers/git-env.js';
import { createRepo, type TempRepo } from '../helpers/repo.js';

isolateGitConfig();

const NOW = new Date('2026-05-06T07:08:09.000Z');

const APP_BEFORE = 'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n';
const APP_AFTER = 'export function greet(name: string, loud: boolean): string {\n  return loud ? `HI ${name}` : `hi ${name}`;\n}\n';
const UTIL = 'export function pad(text: string): string {\n  return ` ${text} `;\n}\n';
const MOVED = 'export function shout(text: string): string {\n  return text.toUpperCase();\n}\n\nexport const volume = 11;\n';
const FRESH = 'export function wave(): string {\n  return "o/";\n}\n';

let scratch: string;
let markers: string;

/** A script that records `name` in the markers directory, then behaves like `behaviour`. */
async function markerScript(name: string, behaviour: string): Promise<string> {
  const path = join(scratch, 'bin', name);
  await writeFile(path, `#!/bin/sh\n: > "${join(markers, name)}"\n${behaviour}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function markersSeen(): Promise<string[]> {
  return (await readdir(markers)).sort();
}

const repos: TempRepo[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'diffcity-untrusted-'));
  markers = join(scratch, 'markers');
  await mkdir(markers);
  await mkdir(join(scratch, 'bin'));
  await mkdir(join(scratch, 'home'));
  // Nothing may read or write the real home: git, the config loader and anything else see a temp one.
  vi.stubEnv('HOME', join(scratch, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(scratch, 'home', '.config'));
});

afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

/**
 * main: app.ts, util.ts, moved.ts. feature: app.ts changed. Then, uncommitted:
 * util.ts rewritten with the same bytes (stat-dirty, so git must hash it),
 * moved.ts renamed to renamed.ts, fresh.ts untracked.
 */
async function repoWithChanges(): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/app.ts': APP_BEFORE, 'src/util.ts': UTIL, 'src/moved.ts': MOVED },
  });
  repos.push(repo);
  await repo.branch('feature');
  await repo.commit('loud greet', { 'src/app.ts': APP_AFTER });
  return repo;
}

async function dirtyWorktree(repo: TempRepo): Promise<void> {
  await repo.write({ 'src/util.ts': UTIL, 'src/fresh.ts': FRESH });
  const future = new Date(Date.now() + 60_000);
  await utimes(join(repo.dir, 'src/util.ts'), future, future);
  await rename(join(repo.dir, 'src/moved.ts'), join(repo.dir, 'src/renamed.ts'));
}

type Variant = 'clean' | 'process';

/** Points every command git can take from the repo at a marker script. Written after the commits. */
async function armRepo(repo: TempRepo, variant: Variant): Promise<void> {
  const tamper = 'echo "export const tampered = true;"';
  const clean = await markerScript('filter-clean', tamper);
  const smudge = await markerScript('filter-smudge', tamper);
  const process = await markerScript('filter-process', 'exit 1');
  const textconv = await markerScript('diff-textconv', tamper);
  const external = await markerScript('diff-external', 'exit 0');
  const driver = await markerScript('diff-command', 'exit 0');
  const hook = await markerScript('hook', 'exit 0');
  const hooksDir = join(scratch, 'hooks');
  await mkdir(hooksDir);
  for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout']) {
    await writeFile(join(hooksDir, name), `#!/bin/sh\nexec "${hook}"\n`, { encoding: 'utf8', mode: 0o755 });
  }

  const config = [
    variant === 'clean' ? `\tclean = ${clean}\n\tsmudge = ${smudge}\n` : `\tprocess = ${process}\n`,
  ];
  await writeFile(
    join(repo.dir, '.git', 'config'),
    [
      `[filter "x"]\n${config.join('')}\trequired = true\n`,
      // A name containing "=" cannot be overridden through `-c name=value`.
      `[filter "odd=name"]\n${config.join('')}`,
      `[diff "x"]\n\ttextconv = ${textconv}\n\tcommand = ${driver}\n`,
      `[diff]\n\texternal = ${external}\n`,
      `[core]\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${hook}\n\tpager = ${hook}\n`,
    ].join(''),
    { encoding: 'utf8', flag: 'a' },
  );
  await writeFile(
    join(repo.dir, '.git', 'info', 'attributes'),
    '*.ts filter=x diff=x\nsrc/util.ts filter=odd=name\n',
    'utf8',
  );
  // The same mapping as a working tree file: untracked, so it also shows up as a change.
  await writeFile(join(repo.dir, '.gitattributes'), '*.ts filter=x diff=x\n', 'utf8');
}

function filesOf(report: Report): Record<string, string> {
  return Object.fromEntries(report.packages.flatMap((pkg) => pkg.files).map((file) => [file.path, file.status]));
}

describe.each<Variant>(['clean', 'process'])('repo-configured commands (filter.x.%s)', (variant) => {
  it('runs none of them while reading the working tree, and reads the real content', { timeout: 60_000 }, async () => {
    const repo = await repoWithChanges();
    await dirtyWorktree(repo);
    await armRepo(repo, variant);
    expect(await markersSeen()).toEqual([]);

    const change: ResolvedChange = await resolveChange(repo.dir, { base: 'main', runner: ghForbidden().runner });
    expect(change.worktree).toBe(true);

    expect(await changedFiles(change)).toEqual([
      { path: '.gitattributes', oldPath: null, type: 'add', binary: false },
      { path: 'src/app.ts', oldPath: 'src/app.ts', type: 'mod', binary: false },
      { path: 'src/fresh.ts', oldPath: null, type: 'add', binary: false },
      { path: 'src/renamed.ts', oldPath: 'src/moved.ts', type: 'rename', binary: false },
    ]);
    expect(await readBefore(change, 'src/app.ts')).toBe(APP_BEFORE);
    expect(await readAfter(change, 'src/app.ts')).toBe(APP_AFTER);
    expect((await readAfterBatch(change, ['src/util.ts', 'src/fresh.ts'])).map((b) => b?.toString('utf8'))).toEqual([
      UTIL,
      FRESH,
    ]);
    expect(await listHeadFiles(change)).toEqual([
      '.gitattributes',
      'src/app.ts',
      'src/fresh.ts',
      'src/renamed.ts',
      'src/util.ts',
    ]);
    expect((await computeMeta(change, NOW)).commits).toBe(1);

    const report = await buildReport({ repoDir: repo.dir, base: 'main', now: NOW, runner: ghForbidden().runner });
    expect(filesOf(report)).toEqual({
      '.gitattributes': 'add',
      'src/app.ts': 'sig',
      'src/fresh.ts': 'add',
      // A pure rename takes its status from git (SPEC 5, ADR-008).
      'src/renamed.ts': 'mod',
      'src/util.ts': 'same',
    });

    expect(await markersSeen()).toEqual([]);
  });

  it('runs none of them while reading a commit', { timeout: 60_000 }, async () => {
    const repo = await repoWithChanges();
    await armRepo(repo, variant);

    const change = await resolveChange(repo.dir, { base: 'main', head: 'feature', runner: ghForbidden().runner });
    expect(await changedFiles(change)).toEqual([
      { path: 'src/app.ts', oldPath: 'src/app.ts', type: 'mod', binary: false },
    ]);
    expect(await readBefore(change, 'src/app.ts')).toBe(APP_BEFORE);
    expect(await readAfter(change, 'src/app.ts')).toBe(APP_AFTER);
    expect((await readAfterBatch(change, ['src/util.ts', 'src/moved.ts'])).map((b) => b?.toString('utf8'))).toEqual([
      UTIL,
      MOVED,
    ]);
    expect(await listHeadFiles(change)).toEqual(['src/app.ts', 'src/moved.ts', 'src/util.ts']);
    expect(await computeMeta(change, NOW)).toEqual({
      repo: 'sample-shop',
      base: 'main',
      head: 'feature',
      commits: 1,
      generatedAt: NOW.toISOString(),
    });

    const report = await buildReport({
      repoDir: repo.dir,
      base: 'main',
      head: 'feature',
      now: NOW,
      runner: ghForbidden().runner,
    });
    expect(filesOf(report)).toEqual({ 'src/app.ts': 'sig', 'src/moved.ts': 'same', 'src/util.ts': 'same' });

    expect(await markersSeen()).toEqual([]);
  });
});

describe('filters from the user own config', () => {
  it('still run when the repo only selects them, and a repo override of one is ignored', { timeout: 120_000 }, async () => {
    const repo = await repoWithChanges();
    await dirtyWorktree(repo);
    // The user's global config (a temp file standing in for ~/.gitconfig) defines an identity filter.
    const trusted = await markerScript('trusted-clean', 'cat');
    const globalConfig = join(scratch, 'home', '.gitconfig');
    await writeFile(globalConfig, `[filter "user"]\n\tclean = ${trusted}\n`, 'utf8');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    const hijack = await markerScript('repo-clean', 'echo "export const tampered = true;"');
    await writeFile(join(repo.dir, '.git', 'config'), `[filter "user"]\n\tclean = ${hijack}\n`, {
      encoding: 'utf8',
      flag: 'a',
    });
    await writeFile(join(repo.dir, '.git', 'info', 'attributes'), '*.ts filter=user\n', 'utf8');

    const change = await resolveChange(repo.dir, { base: 'main', runner: ghForbidden().runner });
    expect((await changedFiles(change)).map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/fresh.ts',
      'src/renamed.ts',
    ]);
    expect(await markersSeen()).toEqual(['trusted-clean']);
  });
});

describe('a submodule', () => {
  it('is not looked into, so its own repo filters never run', { timeout: 120_000 }, async () => {
    const lib = await createRepo({ name: 'sample-lib', files: { 'src/pad.ts': UTIL } });
    repos.push(lib);
    const repo = await repoWithChanges();
    await repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', lib.dir, 'vendor/lib');
    await repo.commit('vendor lib');

    // The submodule's own config and attributes select a filter; its working tree is dirty.
    const clean = await markerScript('submodule-clean', 'echo "export const tampered = true;"');
    await repo.git('-C', 'vendor/lib', 'config', 'filter.x.clean', clean);
    await repo.git('-C', 'vendor/lib', 'config', 'filter.x.required', 'true');
    const attributes = await repo.git('-C', 'vendor/lib', 'rev-parse', '--path-format=absolute', '--git-path', 'info/attributes');
    await mkdir(join(attributes, '..'), { recursive: true });
    await writeFile(attributes, '*.ts filter=x\n', 'utf8');
    const future = new Date(Date.now() + 60_000);
    await utimes(join(repo.dir, 'vendor/lib/src/pad.ts'), future, future);
    await writeFile(join(repo.dir, 'vendor/lib/src/extra.ts'), FRESH, 'utf8');
    expect(await markersSeen()).toEqual([]);

    const change = await resolveChange(repo.dir, { base: 'main', runner: ghForbidden().runner });
    expect((await changedFiles(change)).map((file) => file.path)).toEqual(['.gitmodules', 'src/app.ts']);
    expect(await listHeadFiles(change)).toEqual(['.gitmodules', 'src/app.ts', 'src/moved.ts', 'src/util.ts']);
    const report = await buildReport({ repoDir: repo.dir, base: 'main', now: NOW, runner: ghForbidden().runner });
    expect(filesOf(report)).toEqual({
      '.gitmodules': 'add',
      'src/app.ts': 'sig',
      'src/moved.ts': 'same',
      'src/util.ts': 'same',
    });

    expect(await markersSeen()).toEqual([]);
  });
});

/** A `--no-checkout` partial clone of a repoWithChanges whose upload-pack command is a marker script. */
async function partialClone(filter: string, extraConfig = ''): Promise<string> {
  const origin = await repoWithChanges();
  await origin.git('config', 'uploadpack.allowFilter', 'true');
  await origin.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const cloneDir = join(scratch, 'clone');
  await origin.git('clone', '--quiet', '--no-checkout', `--filter=${filter}`, `file://${origin.dir}`, cloneDir);
  // A fetch of a missing object would go through the repo's own upload-pack command.
  const uploadPack = await markerScript('upload-pack', 'exec git-upload-pack "$@"');
  await writeFile(join(cloneDir, '.git', 'config'), `[remote "origin"]\n\tuploadpack = ${uploadPack}\n${extraConfig}`, {
    encoding: 'utf8',
    flag: 'a',
  });
  return cloneDir;
}

describe('a partial clone', () => {
  it('never fetches a missing object, and says so instead of reporting the file as absent', { timeout: 60_000 }, async () => {
    const cloneDir = await partialClone('blob:none');
    const change = await resolveChange(cloneDir, {
      base: 'origin/main',
      head: 'origin/feature',
      runner: ghForbidden().runner,
    });
    const missing = readBefore(change, 'src/app.ts');
    await expect(missing).rejects.toBeInstanceOf(GitError);
    await expect(readBefore(change, 'src/absent.ts')).resolves.toBeNull();
    await expect(readAfterBatch(change, ['src/util.ts'])).rejects.toBeInstanceOf(GitError);

    expect(await markersSeen()).toEqual([]);
  });

  it('fails instead of reporting a file as absent when the tree itself is missing', { timeout: 60_000 }, async () => {
    const cloneDir = await partialClone('tree:0');
    const change = await resolveChange(cloneDir, {
      base: 'origin/main',
      head: 'origin/feature',
      runner: ghForbidden().runner,
    });
    await expect(readBefore(change, 'src/app.ts')).rejects.toBeInstanceOf(GitError);
    await expect(readAfterBatch(change, ['src/util.ts'])).rejects.toBeInstanceOf(GitError);

    expect(await markersSeen()).toEqual([]);
  });

  it('refuses the transport even when lazy fetching is on and the repo allows it', { timeout: 60_000 }, async () => {
    // git before 2.44 ignores GIT_NO_LAZY_FETCH; the transport block must hold on its own,
    // also for subcommands that skip the config lookup, and against a repo-set protocol.file.allow.
    const cloneDir = await partialClone('blob:none', '[protocol "file"]\n\tallow = always\n[protocol]\n\tallow = always\n');
    const result = await gitRaw(cloneDir, ['cat-file', 'blob', 'origin/main:src/app.ts'], {
      env: { GIT_NO_LAZY_FETCH: '0' },
    });
    expect(result.exitCode).not.toBe(0);
    expect(await markersSeen()).toEqual([]);
  });
});
