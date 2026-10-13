// Shared pieces of the phase 4 acceptance specs (code-review-loop,
// session-context) and the DC-140 proof: the built `setup-claude` run against a
// temporary CLAUDE_CONFIG_DIR, the commands it wrote (the /diffcity-review
// steps and the Stop and SessionEnd hook) run through a shell as Claude Code
// runs them, a browser opener stub that records the URL it was asked to open,
// and the invented shopfront and ledger repos. Nothing here touches the real
// ~/.claude or ~/.config/diffcity, and nothing runs the real claude, gh or npm.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';
import { ghStubEnv } from './acceptance.js';
import { getJson, until } from './change-daemon.js';
import type { ProofWorld } from './proof.js';

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `command` through /bin/sh in `cwd`, as Claude Code runs a hook or a Bash tool call; `input` goes to stdin. */
export function sh(command: string, cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}

/** Runs the built CLI in `cwd`; resolves with its output whatever the exit code. */
export function cliRun(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_DIST, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
}

const OPENER = `#!/bin/sh
printf '%s\\n' "$1" >> "$(dirname "$0")/../opened.txt"
exit 0
`;

export interface LoopEnv {
  env: NodeJS.ProcessEnv;
  /** The temporary Claude Code configuration directory (CLAUDE_CONFIG_DIR). */
  claude: string;
  /** The URLs the browser opener stub was asked to open, oldest first. */
  opened(): Promise<string[]>;
}

/**
 * The environment of every process of a phase 4 acceptance spec: the gh stub
 * and a browser opener stub (`open` on macOS, `xdg-open` on Linux) first on
 * PATH, CLAUDE_CONFIG_DIR in the world's root, and no PATH entry that holds a
 * `diffcity`, so setup-claude never picks a global install over the built CLI.
 */
export async function loopEnv(world: ProofWorld): Promise<LoopEnv> {
  const claude = join(world.root, 'claude');
  await mkdir(join(claude, 'projects'), { recursive: true });
  const base = await ghStubEnv(world.root, { ...world.env, CLAUDE_CONFIG_DIR: claude }, []);
  const bin = join(world.root, 'bin');
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(bin, name), OPENER);
    await chmod(join(bin, name), 0o755);
  }
  const path = (base['PATH'] ?? '').split(delimiter).filter((entry) => entry === bin || !existsSync(join(entry, 'diffcity')));
  const env: NodeJS.ProcessEnv = { ...base, PATH: path.join(delimiter) };
  Reflect.deleteProperty(env, 'npm_command');
  const openedFile = join(world.root, 'opened.txt');
  return {
    env,
    claude,
    opened: async () => (await readFile(openedFile, 'utf8').catch(() => '')).split('\n').filter((line) => line !== ''),
  };
}

export interface ClaudeSetup {
  /** setup-claude's own output. */
  output: string;
  /** The body of the /diffcity-review command file. */
  commandText: string;
  /** How the command file invokes diffcity: `"<node>" "<dist/cli/index.js>"` for this build. */
  cli: string;
  /** The Stop and SessionEnd hook commands from settings.json. */
  stop: string;
  sessionEnd: string;
  /** The commands of the slash command's body, as written there. */
  steps: { take: string; drop: string; diff: string; importOpen: string };
}

interface HookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

/** The single command of `hooks.<event>` in `settings`. */
function hookOf(settings: { hooks?: Record<string, HookEntry[]> }, event: 'Stop' | 'SessionEnd'): string {
  const commands = (settings.hooks?.[event] ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
  if (commands.length !== 1 || commands[0] === undefined) throw new Error(`settings.json has ${String(commands.length)} ${event} hooks`);
  return commands[0];
}

/** The one backticked command of `text` that contains `part`. */
function backticked(text: string, part: string): string {
  const found = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '').filter((command) => command.includes(part));
  if (found.length !== 1 || found[0] === undefined) throw new Error(`the command file names ${String(found.length)} commands with ${part}`);
  return found[0];
}

/** Runs the built `diffcity setup-claude` with `env` and reads back what it wrote. */
export async function setupClaude(loop: LoopEnv, cwd: string): Promise<ClaudeSetup> {
  const run = await cliRun(['setup-claude'], cwd, loop.env);
  if (run.code !== 0) throw new Error(`setup-claude exited with ${String(run.code)}:\n${run.stderr}`);
  const commandText = await readFile(join(loop.claude, 'commands', 'diffcity-review.md'), 'utf8');
  const settings = JSON.parse(await readFile(join(loop.claude, 'settings.json'), 'utf8')) as { hooks?: Record<string, HookEntry[]> };
  const allowed = /^ {2}- Bash\((.+) diff:\*\)$/m.exec(commandText)?.[1];
  if (allowed === undefined) throw new Error('the command file allows no diffcity diff');
  return {
    output: run.stdout,
    commandText,
    cli: allowed,
    stop: hookOf(settings, 'Stop'),
    sessionEnd: hookOf(settings, 'SessionEnd'),
    steps: {
      take: backticked(commandText, 'mv .diffcity/fix-queue '),
      drop: backticked(commandText, 'rm -r .diffcity/fix-queue.taking'),
      diff: backticked(commandText, ' diff --json --compact'),
      importOpen: backticked(commandText, ' import .diffcity/findings.json --open'),
    },
  };
}

/** The `"<node>" "<dist/cli/index.js>"` form setup-claude writes for this build. */
export const absoluteCli = (): string => `"${process.execPath}" "${CLI_DIST}"`;

export interface HookInput {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
}

/** Runs a hook command from settings.json with Claude Code's hook JSON on stdin, in `input.cwd`. */
export function runHook(command: string, event: 'Stop' | 'SessionEnd', input: HookInput, env: NodeJS.ProcessEnv): Promise<Run> {
  const json = {
    session_id: input.sessionId,
    transcript_path: input.transcriptPath,
    cwd: input.cwd,
    hook_event_name: event,
    ...(event === 'SessionEnd' ? { reason: 'prompt_input_exit' } : {}),
  };
  return sh(command, input.cwd, env, JSON.stringify(json));
}

// shopfront: a cart total that now applies a discount code.

export const TOTAL = 'src/cart/total.ts';
export const DISCOUNT = 'src/cart/discount.ts';
export const FORMAT = 'src/cart/format.ts';
export const SHOP_BRANCH = 'feature/discounts';

const TOTAL_AFTER = `import { applyDiscount } from './discount';

export function total(prices: number[], code: string): number {
  const sum = prices.reduce((a, b) => a + b, 0);
  return applyDiscount(sum, code);
}
`;

export const DISCOUNT_AFTER = `export function applyDiscount(sum: number, code: string): number {
  if (code === 'HALF') return sum / 2;
  return sum - Number(code);
}
`;

/** The agent's fix of the high finding: the body of applyDiscount changes. */
export const DISCOUNT_FIXED = `export function applyDiscount(sum: number, code: string): number {
  if (code === 'HALF') return sum / 2;
  return sum;
}
`;

/** shopfront on `feature/discounts`, one commit ahead of `main`: total.ts modified, discount.ts new, format.ts untouched. */
export async function buildShopfront(): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'shopfront',
    files: {
      [TOTAL]: 'export function total(prices: number[]): number {\n  return prices.length;\n}\n',
      [FORMAT]: 'export function formatCents(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n',
      'README.md': '# shopfront\n',
    },
  });
  await repo.branch(SHOP_BRANCH);
  await repo.commit('apply a discount code to the total', { [TOTAL]: TOTAL_AFTER, [DISCOUNT]: DISCOUNT_AFTER });
  return repo;
}

// ledger: a journal that now posts entries in pairs.

export const JOURNAL = 'src/journal/post.ts';
export const LEDGER_BRANCH = 'feature/double-entry';

/** ledger on `feature/double-entry`, one commit ahead of `main`. */
export async function buildLedger(): Promise<TempRepo> {
  const repo = await createRepo({
    name: 'ledger',
    files: {
      [JOURNAL]: 'export function post(amount: number): number[] {\n  return [amount];\n}\n',
      'src/journal/balance.ts': 'export function balance(entries: number[]): number {\n  return entries.reduce((a, b) => a + b, 0);\n}\n',
      'README.md': '# ledger\n',
    },
  });
  await repo.branch(LEDGER_BRANCH);
  await repo.commit('post both sides of an entry', {
    [JOURNAL]: 'export function post(amount: number): number[] {\n  return [amount, -amount];\n}\n\nexport function reverse(entries: number[]): number[] {\n  return entries.map((entry) => -entry);\n}\n',
  });
  return repo;
}

/** The working tree's path as Claude Code records it: the real path (on macOS, /private/var/...). */
export const realDir = (repo: TempRepo): Promise<string> => realpath(repo.dir);

export interface Collected {
  repoId: number;
  changeId: number;
  reportUrl: string;
  /** The change screen with the scene's debug hook on. */
  url: string;
  report(): Promise<Report>;
}

/** Waits until the daemon has `name` with the change of `branch` and its first snapshot. */
export async function collected(world: ProofWorld, name: string, branch: string): Promise<Collected> {
  const base = world.baseURL;
  const repoId = await until(async () => (await getJson<RepoSummary[]>(`${base}/api/repos`)).find((repo) => repo.name === name)?.id, 60_000, `${name} in /api/repos`);
  const change = await until(
    async () => (await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`)).changes.find((c) => c.ref.endsWith(branch) && c.stats !== null),
    60_000,
    `the ${branch} change with its first snapshot`,
  );
  const reportUrl = `${base}/api/changes/${String(change.id)}/report`;
  return {
    repoId,
    changeId: change.id,
    reportUrl,
    url: `${base}/?scene-debug#/change/${String(change.id)}`,
    report: () => getJson<Report>(reportUrl),
  };
}

/** The ids of the files of `report`, touched or not. */
export const fileIds = (report: Report): string[] => report.packages.flatMap((pkg) => pkg.files.map((file) => file.id));
