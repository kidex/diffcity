// Leftover recovery of the /diffcity-review take (DC-112): an earlier run left
// `.diffcity/fix-queue.taking/`, and more fixes were queued since. The body's
// own commands (slashCommands) run through /bin/sh at the working tree root,
// and the items are listed as the command's Glob does,
// `.diffcity/fix-queue.taking/**/*.json`. Every item is applied exactly once,
// whether the leftover is applied and removed first (the body's order) or the
// new queue is moved while the leftover is still there (`mv` then puts it
// inside the leftover, which the `**` pattern still finds).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slashCommands } from '../../../src/core/claude/command-file.js';
import { appendToFixQueue, type FindingQueueItem } from '../../../src/core/fix-queue/index.js';

const { take, drop } = slashCommands('diffcity');
const TAKING = join('.diffcity', 'fix-queue.taking');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-fixq-left-'));
  roots.push(root);
  return root;
}

const sh = (root: string, command: string): void => {
  execFileSync('/bin/sh', ['-c', command], { cwd: root, stdio: 'pipe' });
};

function item(name: string): FindingQueueItem {
  return {
    key: `f:${name}`,
    file: 'src/kettle/brew.ts',
    line: 2,
    severity: 'med',
    title: `Invented finding ${name}`,
    message: 'An invented finding.',
    queuedAt: '2026-10-08T09:00:00.000Z',
  };
}

function queue(root: string, names: string[]): void {
  for (const name of names) expect(appendToFixQueue(root, item(name))).toMatchObject({ ok: true, queued: true });
}

/** `.diffcity/fix-queue.taking/**\/*.json`, as Glob lists it: every item file at any depth. */
function globTaken(root: string): string[] {
  const dir = join(root, TAKING);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.json'))
    .map((path) => join(dir, path));
}

/** Reads every taken item (the agent applies it), then runs the body's `rm -r`. */
function applyTaken(root: string, applied: string[]): void {
  for (const path of globTaken(root)) applied.push((JSON.parse(readFileSync(path, 'utf8')) as FindingQueueItem).key);
  sh(root, drop);
}

describe('fix-queue/leftover-recovery (DC-112)', () => {
  it('fix-queue/leftover-applied-first: the leftover is applied and removed, then the new queue is taken; each item once', () => {
    const root = tree();
    const applied: string[] = [];
    queue(root, ['a1', 'a2']);
    sh(root, take); // the interrupted run took it and stopped
    queue(root, ['b1', 'b2', 'b3']);

    expect(existsSync(join(root, TAKING))).toBe(true);
    applyTaken(root, applied);
    sh(root, take);
    applyTaken(root, applied);

    expect([...applied].sort()).toEqual(['f:a1', 'f:a2', 'f:b1', 'f:b2', 'f:b3']);
    expect(readdirSync(join(root, '.diffcity'))).toEqual([]);
  });

  it('fix-queue/leftover-moved-into: a take while the leftover is still there nests the queue in it; Glob ** still reads each item once', () => {
    const root = tree();
    const applied: string[] = [];
    queue(root, ['a1', 'a2']);
    sh(root, take);
    queue(root, ['b1', 'b2', 'b3']);

    sh(root, take);
    expect(existsSync(join(root, TAKING, 'fix-queue'))).toBe(true);
    applyTaken(root, applied);

    expect([...applied].sort()).toEqual(['f:a1', 'f:a2', 'f:b1', 'f:b2', 'f:b3']);
    expect(readdirSync(join(root, '.diffcity'))).toEqual([]);
    // The next fix starts a fresh queue.
    queue(root, ['c1']);
    expect(readdirSync(join(root, '.diffcity'))).toEqual(['fix-queue']);
  });

  it('fix-queue/take-with-nothing-queued: the take fails without a queue and the body has nothing to apply', () => {
    const root = tree();
    expect(() => {
      sh(root, take);
    }).toThrow();
    expect(globTaken(root)).toEqual([]);
  });
});
