// The shell hooks printed by `diffcity shell-init` (SPEC.md section 3a C1,
// ADR-016, Q1), run in real shells: zsh, bash (3.2, the macOS default, and any
// bash >= 5 found) and fish (skipped when missing). `node` is replaced by a
// stub script that logs its arguments, so no daemon is involved. Every path in
// the fixture contains spaces and quotes.

import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { quotePosix, shellInitScript, type HookCommand, type Shell } from '../../../src/cli/shell-init.js';
import { HOME_ENV } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';

// ---------------------------------------------------------------------------
// The shells on this machine

interface ShellBinary {
  shell: Shell;
  bin: string;
  /** `major.minor` for bash, '' otherwise. */
  version: string;
  label: string;
}

function onPath(name: string): string[] {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, name))
    .filter((file) => existsSync(file));
}

function bashVersion(bin: string): string {
  return execFileSync(bin, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim();
}

function findBashes(): ShellBinary[] {
  const candidates = ['/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/usr/bin/bash', ...onPath('bash')];
  const extra = process.env.DIFFCITY_TEST_BASH;
  if (extra !== undefined && extra !== '') candidates.push(extra);
  const byVersion = new Map<string, ShellBinary>();
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const version = bashVersion(bin);
    if (!byVersion.has(version)) byVersion.set(version, { shell: 'bash', bin, version, label: `bash ${version}` });
  }
  return [...byVersion.values()];
}

const zshBin = ['/bin/zsh', ...onPath('zsh')].find((file) => existsSync(file));
const fishBin = onPath('fish')[0];
const bashes = findBashes();
const bash32 = bashes.find((bash) => bash.version === '3.2');
const bash5 = bashes.find((bash) => Number(bash.version.split('.')[0]) >= 5);

const SHELL_BINARIES: ShellBinary[] = [
  ...(zshBin === undefined ? [] : [{ shell: 'zsh' as const, bin: zshBin, version: '', label: 'zsh' }]),
  ...bashes,
  ...(fishBin === undefined ? [] : [{ shell: 'fish' as const, bin: fishBin, version: '', label: 'fish' }]),
];

// ---------------------------------------------------------------------------
// The fixture: a root whose name has spaces and quotes, two repos, a plain folder

let temp: TempHome;
let root: string;
let log: string;
let command: HookCommand;
let dirs: { work: string; shop: string; shopDeep: string; orders: string; ordersDeep: string; plain: string };
const hookFile = (shell: Shell): string => join(root, `hook.${shell}`);

beforeAll(async () => {
  temp = await tempHome();
  root = await realpath(await mkdtemp(join(tmpdir(), `dc-shell it's "q" `)));
  const bin = join(root, `bin dir $HOME`);
  await mkdir(bin);
  const node = join(bin, `it's "node"`);
  // Logs `<arg>\t<arg>\t...` in one write, so lines from concurrent stubs never interleave.
  await writeFile(node, '#!/bin/sh\nline=\nfor a; do line="$line$a\t"; done\nprintf \'%s\\n\' "$line" >> "$DIFFCITY_STUB_LOG"\n');
  await chmod(node, 0o755);
  command = { node, cli: join(root, `lib \`x\``, `"cli" it's.js`) };
  log = join(root, 'calls.log');

  const work = join(root, 'work');
  const shop = join(work, 'sample shop');
  const orders = join(work, `order's "service"`);
  dirs = {
    work,
    shop,
    shopDeep: join(shop, 'src', 'a', 'b', 'c', 'd', 'e', 'f'),
    orders,
    ordersDeep: join(orders, 'lib', 'a', 'b', 'c', 'd', 'e', 'f'),
    plain: join(work, 'plain notes'),
  };
  // Only the `.git` entry matters to the hook: a directory, or a file as in a linked worktree.
  await mkdir(join(shop, '.git'), { recursive: true });
  await mkdir(dirs.shopDeep, { recursive: true });
  await mkdir(dirs.ordersDeep, { recursive: true });
  await writeFile(join(orders, '.git'), 'gitdir: /elsewhere/.git/worktrees/order-service\n');
  await mkdir(join(dirs.plain, 'inner'), { recursive: true });

  for (const shell of ['zsh', 'bash', 'fish'] as const) await writeFile(hookFile(shell), shellInitScript(shell, command));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await temp.cleanup();
});

// ---------------------------------------------------------------------------
// Running a shell

function shellEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: temp.userHome,
    [HOME_ENV]: temp.home,
    LC_ALL: 'C',
    TERM: 'dumb',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    DIFFCITY_STUB_LOG: log,
    ...extra,
  };
}

/** The line that loads the hook, the way the user's rc file does. */
function loadLine(shell: Shell): string {
  return shell === 'fish' ? `source ${quotePosix(hookFile(shell))}` : `eval "$(cat ${quotePosix(hookFile(shell))})"`;
}

/** Quotes a path for the driver script; fish takes the POSIX form for these paths (no backslashes). */
const q = (path: string): string => quotePosix(path);

interface ShellRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `lines` in an interactive zsh or bash (so prompts, PROMPT_COMMAND and
 * job notices behave as for a user) or in fish, starting in `cwd`.
 */
async function runShell(binary: ShellBinary, cwd: string, lines: string[], env: NodeJS.ProcessEnv = {}): Promise<ShellRun> {
  const args = { zsh: ['-f', '-i'], bash: ['--norc', '--noprofile', '-i'], fish: ['--no-config'] }[binary.shell];
  const prelude = binary.shell === 'fish' ? [] : [`PS1=''`];
  const child = spawn(binary.bin, args, { cwd, env: shellEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(`${[...prelude, ...lines, 'exit'].join('\n')}\n`);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

async function readCalls(): Promise<string[][]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t').slice(0, -1));
}

/**
 * Waits for `count` stub calls, then a little longer so a stray extra call
 * would show up. Sorted: background calls may land in any order.
 */
async function settledCalls(count: number): Promise<string[][]> {
  const deadline = Date.now() + 10_000;
  while ((await readCalls()).length < count && Date.now() < deadline) await sleep(25);
  await sleep(400);
  return sortCalls(await readCalls());
}

const sortCalls = (calls: string[][]): string[][] => [...calls].sort((a, b) => a.join('\t').localeCompare(b.join('\t')));

const call = (repoRoot: string): string[] => [command.cli, 'track', repoRoot];

// ---------------------------------------------------------------------------

describe.each(SHELL_BINARIES)('$label hook', (binary) => {
  const { shell } = binary;

  it(`shell/${shell}-fires-once-per-repo: enter, move inside, switch repos, leave, come back`, async () => {
    await rm(log, { force: true });
    const run = await runShell(binary, dirs.work, [
      loadLine(shell),
      `cd ${q(dirs.shop)}`,
      `cd ${q(join(dirs.shop, 'src'))}`,
      `cd ${q(dirs.shopDeep)}`,
      `cd ${q(dirs.shop)}`,
      `cd ${q(dirs.orders)}`,
      `cd ${q(dirs.plain)}`,
      `cd ${q(dirs.orders)}`,
      `cd ${q(dirs.ordersDeep)}`,
    ]);
    expect(run.code).toBe(0);
    expect(await settledCalls(3)).toEqual(sortCalls([call(dirs.shop), call(dirs.orders), call(dirs.orders)]));
    // No job notice ("[1] 12345", "[1]+ Done ... track ...") reaches the terminal.
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/\[\d+\]/);
    expect(`${run.stdout}${run.stderr}`).not.toContain('track');
  });

  it(`shell/subfolder-entry-fires (${binary.label}): entering a repo through a subfolder tracks its root`, async () => {
    await rm(log, { force: true });
    await runShell(binary, dirs.work, [loadLine(shell), `cd ${q(dirs.ordersDeep)}`, `cd ${q(dirs.shopDeep)}`]);
    expect(await settledCalls(2)).toEqual(sortCalls([call(dirs.orders), call(dirs.shop)]));
  });

  it(`runs once at shell start for the initial directory (${binary.label})`, async () => {
    await rm(log, { force: true });
    await runShell(binary, dirs.shopDeep, [loadLine(shell), `cd ${q(dirs.shop)}`]);
    expect(await settledCalls(1)).toEqual([call(dirs.shop)]);
  });

  it(`shell/non-repo-no-call (${binary.label}): directories outside a repo start no process`, async () => {
    await rm(log, { force: true });
    await runShell(binary, dirs.work, [loadLine(shell), `cd ${q(dirs.plain)}`, `cd ${q(join(dirs.plain, 'inner'))}`, `cd ${q(root)}`]);
    expect(await settledCalls(0)).toEqual([]);
  });

  it(`shell/disable-env (${binary.label}): DIFFCITY_DISABLE_HOOK=1 does nothing`, async () => {
    await rm(log, { force: true });
    await runShell(binary, dirs.shop, [loadLine(shell), `cd ${q(dirs.orders)}`, `cd ${q(dirs.shopDeep)}`], { DIFFCITY_DISABLE_HOOK: '1' });
    expect(await settledCalls(0)).toEqual([]);
  });

  it(`shell/paths-with-spaces (${binary.label}): node, the CLI and the repo root arrive as single, exact arguments`, async () => {
    await rm(log, { force: true });
    await runShell(binary, dirs.work, [loadLine(shell), `cd ${q(dirs.orders)}`]);
    const calls = await settledCalls(1);
    expect(calls).toEqual([[command.cli, 'track', dirs.orders]]);
    expect(dirs.orders).toMatch(/ .*'.*"/);
    expect(command.node).toMatch(/ .*'.*"/);
    expect(command.cli).toMatch(/ .*'.*"/);
  });
});

describe.each([bash32, bash5].filter((bash): bash is ShellBinary => bash !== undefined))('$label PROMPT_COMMAND', (binary) => {
  it('keeps an existing PROMPT_COMMAND, keeps $? for it, and installs only once', async () => {
    await rm(log, { force: true });
    const statusLog = join(root, `status ${binary.version}.log`);
    await rm(statusLog, { force: true });
    const run = await runShell(binary, dirs.work, [
      `PROMPT_COMMAND=${q(`echo "status=$?" >> ${q(statusLog)}`)}`,
      loadLine('bash'),
      loadLine('bash'),
      `cd ${q(dirs.shop)}`,
      'false',
      'echo "commands=${#PROMPT_COMMAND[@]} ${PROMPT_COMMAND[*]}"',
    ]);
    expect(await settledCalls(1)).toEqual([call(dirs.shop)]);
    const statuses = (await readFile(statusLog, 'utf8')).trim().split('\n');
    expect(statuses).toContain('status=1');
    const listed = /commands=(\d+) (.*)/.exec(run.stdout);
    expect(listed?.[2]?.match(/__diffcity_prompt/g)).toHaveLength(1);
    // bash >= 5.1 keeps the user's command and the hook as two array entries; older bash, one string.
    const [major = 0, minor = 0] = binary.version.split('.').map(Number);
    expect(listed?.[1]).toBe(major > 5 || (major === 5 && minor >= 1) ? '2' : '1');
  });
});

// ---------------------------------------------------------------------------
// shell/hook-under-50ms: the synchronous cost of a `cd` that enters another repo
// (the walk plus the fork of the background track), median of 20.

const CDS = 20;
const HOOK_BUDGET_MS = 50;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/** Alternates between the deep folders of the two repos, so every `cd` enters another repo. */
const target = (index: number): string => (index % 2 === 0 ? dirs.shopDeep : dirs.ordersDeep);

/** Runs a timing driver non-interactively and parses one number per line of stdout. */
async function timings(bin: string, args: string[], script: string): Promise<number[]> {
  const child = spawn(bin, args, { cwd: dirs.work, env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(script);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(Number);
}

function expectUnderBudget(label: string, values: number[]): void {
  expect(values).toHaveLength(CDS);
  const result = median(values);
  console.info(`shell/hook-under-50ms ${label}: median ${result.toFixed(2)} ms, max ${Math.max(...values).toFixed(2)} ms over ${String(CDS)} cds`);
  expect(result).toBeLessThan(HOOK_BUDGET_MS);
}

describe('shell/hook-under-50ms', () => {
  it.skipIf(zshBin === undefined)('zsh, measured with $EPOCHREALTIME', async () => {
    const lines = ['zmodload zsh/datetime', loadLine('zsh')];
    for (let index = 0; index < CDS; index++) {
      lines.push(`t0=$EPOCHREALTIME; cd ${q(target(index))}; t1=$EPOCHREALTIME; print -r -- $(( (t1 - t0) * 1000 ))`);
    }
    expectUnderBudget('zsh', await timings(zshBin ?? 'zsh', ['-f'], `${lines.join('\n')}\n`));
  });

  it.skipIf(bash5 === undefined)('bash >= 5, measured with $EPOCHREALTIME (cd plus the prompt hook)', async () => {
    const lines = [loadLine('bash'), '__run_prompt() { local c; for c in "${PROMPT_COMMAND[@]}"; do eval "$c"; done; }'];
    for (let index = 0; index < CDS; index++) {
      lines.push(`t0=\${EPOCHREALTIME/./}; cd ${q(target(index))}; __run_prompt; t1=\${EPOCHREALTIME/./}; echo "$(( t1 - t0 ))"`);
    }
    const micros = await timings(bash5?.bin ?? 'bash', ['--norc', '--noprofile'], `${lines.join('\n')}\n`);
    expectUnderBudget(`bash ${bash5?.version ?? ''}`, micros.map((value) => value / 1000));
  });

  it.skipIf(bash32 === undefined)('bash 3.2 (no $EPOCHREALTIME), measured with the time keyword at 1 ms resolution', async () => {
    const lines = [
      loadLine('bash'),
      '__run_prompt() { local c; for c in "${PROMPT_COMMAND[@]}"; do eval "$c"; done; }',
      'TIMEFORMAT=%3R',
    ];
    for (let index = 0; index < CDS; index++) lines.push(`{ time { cd ${q(target(index))}; __run_prompt; }; } 2>&1`);
    const seconds = await timings(bash32?.bin ?? '/bin/bash', ['--norc', '--noprofile'], `${lines.join('\n')}\n`);
    expectUnderBudget('bash 3.2', seconds.map((value) => value * 1000));
  });

  it.skipIf(fishBin === undefined)('fish, measured with the time keyword', async () => {
    const lines = [loadLine('fish')];
    for (let index = 0; index < CDS; index++) lines.push(`begin; time cd ${q(target(index))}; end 2>&1 | string match -r 'Executed in.*'`);
    const child = spawn(fishBin ?? 'fish', ['--no-config'], { cwd: dirs.work, env: shellEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stdin.end(`${lines.join('\n')}\n`);
    await new Promise((resolve) => child.once('exit', resolve));
    const unit: Record<string, number> = { micros: 0.001, millis: 1, secs: 1000, mins: 60_000 };
    const values = [...stdout.matchAll(/Executed in\s+([\d.]+)\s+(micros|millis|secs|mins)/g)].map(
      (match) => Number(match[1]) * (unit[match[2] ?? 'millis'] ?? 1),
    );
    expectUnderBudget('fish', values);
  });
});
