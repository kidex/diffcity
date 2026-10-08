// Shared pieces of the acceptance specs that drive the real daemon from a real
// shell (ADR-023): the invented sample-shop repo with a Draft, a Branch and a
// PR, a gh stub on PATH, the shells installed on this machine, and an
// interactive shell session fed through its stdin.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { devNull } from 'node:os';
import { delimiter, join } from 'node:path';
import { quoteFish, quotePosix } from '../../../src/cli/shell-init.js';
import { CLI_DIST } from '../../helpers/daemon.js';
import { createRepo, type TempRepo } from '../../helpers/repo.js';

export interface SampleShop {
  repo: TempRepo;
  /** Head of feature/checkout, the PR's head. */
  prHead: string;
}

/**
 * sample-shop on `main` with uncommitted work (a Draft), `feature/menu` one
 * commit ahead (a Branch) and `feature/checkout` one commit ahead with an open
 * PR #7 (the PR). The same repo as integration/track-to-api-under-5s.
 */
export async function buildSampleShop(): Promise<SampleShop> {
  const repo = await createRepo({
    name: 'sample-shop',
    files: { 'src/cart/total.ts': 'export const total = 0;\n', 'README.md': '# sample-shop\n' },
  });
  await repo.branch('feature/menu');
  await repo.commit('add the menu', { 'src/menu/dish.ts': 'export function dish(): string {\n  return "soup";\n}\n' });
  await repo.checkout('main');
  await repo.branch('feature/checkout');
  const prHead = await repo.commit('add the checkout', { 'src/checkout/pay.ts': 'export class Pay {}\n' });
  await repo.checkout('main');
  await repo.write({ 'src/cart/line.ts': 'export const line = 1;\n' });
  return { repo, prHead };
}

// gh runs with an allow-listed environment (ADR-032): GH_STUB_PR_LIST reaches the stub
// only when a test execs it directly; under the daemon it reads the file next to it.
const GH_STUB = `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.0.0 (stub)"; exit 0 ;;
  auth) exit 0 ;;
  pr) if [ "$2" = "list" ]; then cat "\${GH_STUB_PR_LIST:-$(dirname "$0")/../pr-list.json}"; exit 0; fi ;;
esac
exit 1
`;

/**
 * Writes a gh stub into `<root>/bin` that answers `pr list` with `prs`, and
 * returns the environment for every process of the test: the stub first on
 * PATH, git without the user's global or system config, and the temporary
 * DIFFCITY_HOME and HOME from `base`.
 */
export async function ghStubEnv(root: string, base: NodeJS.ProcessEnv, prs: unknown[]): Promise<NodeJS.ProcessEnv> {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const gh = join(bin, 'gh');
  await writeFile(gh, GH_STUB);
  await chmod(gh, 0o755);
  const prList = join(root, 'pr-list.json');
  await writeFile(prList, JSON.stringify(prs));
  const user = base['HOME'] ?? root;
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    GH_STUB_PR_LIST: prList,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    // fish keeps its history and universal variables under these.
    XDG_CONFIG_HOME: join(user, '.config'),
    XDG_DATA_HOME: join(user, '.local', 'share'),
    TERM: 'dumb',
  };
  // The first exec of a freshly written script pays macOS's provenance check
  // (the real gh does not); pay it here, before any t0. On macOS under heavy
  // load the check is not reliably cached: an exec of the stub from node can
  // still take seconds, up to the collector's 10 s gh timeout (the PR then
  // shows as a branch). Linux CI has no such check.
  execFileSync(gh, ['--version'], { env });
  return env;
}

/** The PR list the stub returns for sample-shop. */
export const samplePrs = (prHead: string): unknown[] => [
  { number: 7, title: 'Checkout flow', headRefName: 'feature/checkout', headRefOid: prHead, baseRefName: 'main', isCrossRepository: false },
];

export interface ShellSpec {
  /** Test title: `zsh`, `bash 3.2`, `bash 5`, `fish`. */
  name: string;
  shell: 'zsh' | 'bash' | 'fish';
  bin: string;
  args: string[];
}

const firstExisting = (candidates: string[]): string | undefined => candidates.find((bin) => existsSync(bin));

/**
 * The shells to run: zsh and the system bash (3.2 on macOS), plus the bash 5
 * and fish from Homebrew when installed. A bash 5 that is the system bash
 * (Linux) is not run twice.
 */
export function installedShells(): ShellSpec[] {
  const shells: ShellSpec[] = [];
  const zsh = firstExisting(['/bin/zsh', '/usr/bin/zsh']);
  if (zsh !== undefined) shells.push({ name: 'zsh', shell: 'zsh', bin: zsh, args: ['-f', '-i'] });
  const bashArgs = ['--norc', '--noprofile', '-i'];
  const systemBash = firstExisting(['/bin/bash', '/usr/bin/bash']);
  if (systemBash !== undefined) shells.push({ name: `bash ${bashVersion(systemBash)}`, shell: 'bash', bin: systemBash, args: bashArgs });
  const brewBash = firstExisting(['/opt/homebrew/bin/bash', '/usr/local/bin/bash']);
  if (brewBash !== undefined && (systemBash === undefined || realpathSync(brewBash) !== realpathSync(systemBash))) {
    shells.push({ name: `bash ${bashVersion(brewBash)}`, shell: 'bash', bin: brewBash, args: bashArgs });
  }
  const fish = firstExisting(['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish']);
  // fish reads a piped stdin to the end before running any of it, so the
  // session runs a read-eval loop instead: each line runs as it arrives, in
  // the same fish, where the hook's PWD handler fires on `cd`.
  if (fish !== undefined) {
    shells.push({ name: 'fish', shell: 'fish', bin: fish, args: ['--no-config', '-c', 'while read -l line; eval $line; end'] });
  }
  return shells;
}

/** `3.2`, `5.3`: the major and minor version of a bash binary. */
function bashVersion(bin: string): string {
  const out = execFileSync(bin, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' });
  return out.trim();
}

export interface ShellSession {
  /** Writes one command line to the shell. */
  run(line: string): void;
  /** Resolves once the shell printed `marker` on stdout. */
  waitFor(marker: string, timeoutMs?: number): Promise<void>;
  /** Everything the shell printed so far (stdout and stderr). */
  output(): string;
  /** Sends `exit` and waits for the shell to end; kills it after 5 s. */
  close(): Promise<number | null>;
}

const READY = '__diffcity_ready__';

/**
 * Starts `spec` interactively in `cwd` (not a repo), loads the hook printed by
 * the built `diffcity shell-init`, and resolves once the hook is loaded and the
 * shell waits for input. The hook's initial call finds no repo, so nothing is
 * tracked before the first `cd`.
 */
export async function openShell(spec: ShellSpec, cwd: string, env: NodeJS.ProcessEnv, hookDir: string): Promise<ShellSession> {
  const script = execFileSync(process.execPath, [CLI_DIST, 'shell-init', spec.shell], { env, encoding: 'utf8' });
  const hookFile = join(hookDir, `hook.${spec.shell}`);
  await writeFile(hookFile, script);
  const child: ChildProcess = spawn(spec.bin, spec.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) throw new Error('shell without pipes');
  let out = '';
  let all = '';
  stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
    all += chunk;
  });
  stderr.setEncoding('utf8').on('data', (chunk: string) => (all += chunk));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => { resolve(code); }));

  const session: ShellSession = {
    run(line) {
      stdin.write(`${line}\n`);
    },
    async waitFor(marker, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!out.includes(marker)) {
        if (child.exitCode !== null) throw new Error(`${spec.name} exited with ${String(child.exitCode)}:\n${all}`);
        if (Date.now() > deadline) throw new Error(`${spec.name} did not print ${marker} within ${String(timeoutMs)} ms:\n${all}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    output: () => all,
    async close() {
      if (child.exitCode === null) stdin.end('exit\n');
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => { resolve('timeout'); }, 5000));
      if ((await Promise.race([exited, timeout])) === 'timeout') child.kill('SIGKILL');
      return exited;
    },
  };

  if (spec.shell === 'fish') {
    session.run(`source ${quoteFish(hookFile)}`);
  } else {
    session.run(`PS1=''`);
    session.run(`eval "$(cat ${quotePosix(hookFile)})"`);
  }
  session.run(`echo ${READY}`);
  await session.waitFor(READY);
  return session;
}

/** `cd` into `dir`, quoted for the shell. */
export const cdLine = (spec: ShellSpec, dir: string): string => `cd ${spec.shell === 'fish' ? quoteFish(dir) : quotePosix(dir)}`;

/** A TCP port free on 127.0.0.1 right now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}
