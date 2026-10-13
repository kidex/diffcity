// git is spawned through an absolute path (DC-143). Spawned by its bare name,
// every PATH entry before git's own is a failed exec attempt; on macOS those
// attempts leave a backlog that the next exec of a third-party binary (the
// CLI's node, gh) pays in one go, up to tens of seconds after a collection of a
// few hundred files. The path is found once per PATH value, from its absolute
// entries only (a repo's own ./bin/git never stands in), and found again after
// a spawn reports it missing.

import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The file of every spawn, in order. */
const spawned: string[] = [];
/** The error the next execFile reports, if any. */
let nextError: NodeJS.ErrnoException | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  const execFile = (file: string, _args: unknown, _options: unknown, callback: (error: unknown, stdout: Buffer, stderr: Buffer) => void): unknown => {
    spawned.push(file);
    const error = nextError;
    nextError = null;
    setImmediate(() => {
      callback(error, Buffer.from('ok\n'), Buffer.alloc(0));
    });
    return { stdin: Object.assign(new EventEmitter(), { end: () => undefined }) };
  };
  const spawn = (file: string): unknown => {
    spawned.push(file);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => undefined });
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { ...original, execFile, spawn };
});

const { gitRaw, gitStream } = await import('../../src/core/git/exec.js');
const { PATH_CACHE_TTL_MS } = await import('../../src/core/exec/resolve.js');

let root = '';
let savedPath: string | undefined;

/** A directory holding an executable `git` stub (never run: spawns are mocked). */
async function gitDir(name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'git'), '#!/bin/sh\nexit 0\n');
  await chmod(join(dir, 'git'), 0o755);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'diffcity-git-binary-'));
  savedPath = process.env['PATH'];
  spawned.length = 0;
  nextError = null;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('the git binary', () => {
  it('is the first absolute PATH entry with an executable git, for gitRaw and gitStream alike', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    // Not an executable file: a directory named git, and a git without the x bit.
    const directory = join(root, 'directory');
    await mkdir(join(directory, 'git'), { recursive: true });
    const plain = join(root, 'plain');
    await mkdir(plain);
    await writeFile(join(plain, 'git'), '#!/bin/sh\n');
    const relative = 'bin';
    const real = await gitDir('tools');
    await gitDir('later');
    process.env['PATH'] = [relative, '', empty, directory, plain, real, join(root, 'later')].join(delimiter);

    await gitRaw(root, ['rev-parse', 'HEAD']);
    await gitStream(root, ['cat-file', 'blob', 'HEAD:README.md'], () => undefined);

    expect(spawned).toEqual([join(real, 'git'), join(real, 'git')]);
  });

  it('is found again for another PATH, and after a spawn reports it missing', async () => {
    const first = await gitDir('first');
    const second = await gitDir('second');
    process.env['PATH'] = first;
    await gitRaw(root, ['rev-parse', 'HEAD']);
    process.env['PATH'] = second;
    await gitRaw(root, ['rev-parse', 'HEAD']);
    expect(spawned).toEqual([join(first, 'git'), join(second, 'git')]);

    // Remembered for its PATH: gone from disk, it is still what the next call spawns, with no new lookup...
    const later = await gitDir('later');
    process.env['PATH'] = [first, later].join(delimiter);
    spawned.length = 0;
    await gitRaw(root, ['rev-parse', 'HEAD']);
    await rm(join(first, 'git'));
    await gitRaw(root, ['rev-parse', 'HEAD']);
    // ...until a spawn says ENOENT; the next call looks again.
    nextError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    await gitRaw(root, ['rev-parse', 'HEAD']).catch(() => undefined);
    await gitRaw(root, ['rev-parse', 'HEAD']);
    expect(spawned).toEqual([join(first, 'git'), join(first, 'git'), join(first, 'git'), join(later, 'git')]);
  });

  it('is found again after a spawn reports it not executable (EACCES)', async () => {
    const first = await gitDir('first');
    const later = await gitDir('later');
    process.env['PATH'] = [first, later].join(delimiter);
    await gitRaw(root, ['rev-parse', 'HEAD']);
    await rm(join(first, 'git'));
    nextError = Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' });
    await gitRaw(root, ['rev-parse', 'HEAD']).catch(() => undefined);
    await gitRaw(root, ['rev-parse', 'HEAD']);
    expect(spawned).toEqual([join(first, 'git'), join(first, 'git'), join(later, 'git')]);
  });

  it('is looked up again once PATH_CACHE_TTL_MS has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const first = await gitDir('first');
      const later = await gitDir('later');
      process.env['PATH'] = [first, later].join(delimiter);
      await gitRaw(root, ['rev-parse', 'HEAD']);
      await rm(join(first, 'git'));
      vi.setSystemTime(Date.now() + PATH_CACHE_TTL_MS - 1);
      await gitRaw(root, ['rev-parse', 'HEAD']);
      vi.setSystemTime(Date.now() + 2);
      await gitRaw(root, ['rev-parse', 'HEAD']);
      expect(spawned).toEqual([join(first, 'git'), join(first, 'git'), join(later, 'git')]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is refused when no absolute PATH entry has one: a relative entry is never searched, nothing is spawned', async () => {
    // A repo's own bin/git, reachable only through the relative entry.
    await gitDir('bin');
    process.env['PATH'] = ['bin', join(root, 'nowhere')].join(delimiter);
    await expect(gitRaw(root, ['rev-parse', 'HEAD'])).rejects.toMatchObject({ name: 'GitError', code: 'git-failed', message: 'git not found on PATH' });
    await expect(gitStream(root, ['cat-file', 'blob', 'HEAD:README.md'], () => undefined)).rejects.toMatchObject({ message: 'git not found on PATH' });
    expect(spawned).toEqual([]);

    // Not remembered: a git installed afterwards is found by the next call.
    const installed = await gitDir('installed');
    process.env['PATH'] = ['bin', installed].join(delimiter);
    await gitRaw(root, ['rev-parse', 'HEAD']);
    expect(spawned).toEqual([join(installed, 'git')]);
  });
});
