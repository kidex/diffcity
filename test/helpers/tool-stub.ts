// Stub binaries for the tool runner tests (ADR-032): `#!/bin/sh` scripts on a
// temporary PATH that record their argv, cwd and environment and answer what
// the test wrote to their `mode` and `stdout` files. The runner passes only an
// allow-listed environment, so a stub is steered through files, not variables.
//
// macOS vets the first exec of every freshly written file (syspolicyd), which
// can take seconds under load: the stubs are written once per test file and
// each is run once by `warm()` before the tests start.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StubRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  pid: number;
}

export interface ToolStubs {
  /** The temporary directory holding everything. */
  dir: string;
  /** The directory to put on PATH. */
  bin: string;
  /** Path of a stub by name. */
  path(name: string): string;
  /**
   * What every stub does next:
   * - `json`: prints the `stdout` file and exits 0;
   * - `fail`: prints the `stderr` file to stderr and exits with the `code` file (1 by default);
   * - `sleep`: starts a background `sleep` (its pid in `grandchild`) and waits;
   * - `sleep-ignore-term`: the same with SIGTERM ignored by both;
   * - `flood-stdout` / `flood-stderr`: writes past the runner's caps.
   */
  mode(mode: 'json' | 'fail' | 'sleep' | 'sleep-ignore-term' | 'flood-stdout' | 'flood-stderr', files?: { stdout?: string; stderr?: string; code?: number }): Promise<void>;
  /** Every call recorded so far, oldest first. */
  records(): Promise<StubRecord[]>;
  /** Forgets the recorded calls. */
  clear(): Promise<void>;
  /** Runs each stub once so the tests do not pay the first-exec check. */
  warm(): Promise<void>;
  cleanup(): Promise<void>;
}

function body(dir: string): string {
  const q = (path: string): string => `"${join(dir, path)}"`;
  return [
    '#!/bin/sh',
    `n=$(date +%s)-$$`,
    `rec=${q('records')}/$n`,
    'mkdir -p "$rec"',
    'echo $$ > "$rec/pid"',
    'pwd -P > "$rec/cwd"',
    'env > "$rec/env"',
    'for a in "$@"; do printf "%s\\0" "$a"; done > "$rec/argv"',
    `mode=$(cat ${q('mode')} 2>/dev/null)`,
    'case "$mode" in',
    `  fail) cat ${q('stderr')} >&2 2>/dev/null; exit $(cat ${q('code')} 2>/dev/null || echo 1) ;;`,
    `  sleep) sleep 600 & echo $! > ${q('grandchild')}; wait ;;`,
    `  sleep-ignore-term) trap '' TERM; sleep 600 & echo $! > ${q('grandchild')}; wait; wait ;;`,
    '  flood-stdout) head -c 17000000 /dev/zero ;;',
    '  flood-stderr) head -c 70000 /dev/zero >&2 ;;',
    `  *) cat ${q('stdout')} 2>/dev/null ;;`,
    'esac',
    '',
  ].join('\n');
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

export async function createToolStubs(names: readonly string[] = ['gh']): Promise<ToolStubs> {
  const dir = await mkdtemp(join(tmpdir(), 'diffcity-tool-stubs-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await mkdir(join(dir, 'records'));
  for (const name of names) {
    await writeFile(join(bin, name), body(dir), 'utf8');
    await chmod(join(bin, name), 0o755);
  }
  const stubs: ToolStubs = {
    dir,
    bin,
    path: (name) => join(bin, name),
    async mode(mode, files = {}) {
      await writeFile(join(dir, 'mode'), mode, 'utf8');
      await writeFile(join(dir, 'stdout'), files.stdout ?? '', 'utf8');
      await writeFile(join(dir, 'stderr'), files.stderr ?? '', 'utf8');
      await writeFile(join(dir, 'code'), String(files.code ?? 1), 'utf8');
      await rm(join(dir, 'grandchild'), { force: true });
    },
    async records() {
      const entries = (await readdir(join(dir, 'records'))).sort();
      return Promise.all(
        entries.map(async (entry) => {
          const at = join(dir, 'records', entry);
          const argv = (await readFile(join(at, 'argv'), 'utf8').catch(() => '')).split('\0');
          argv.pop();
          return {
            argv,
            cwd: (await readFile(join(at, 'cwd'), 'utf8')).trim(),
            env: parseEnv(await readFile(join(at, 'env'), 'utf8')),
            pid: Number((await readFile(join(at, 'pid'), 'utf8')).trim()),
          };
        }),
      );
    },
    async clear() {
      await rm(join(dir, 'records'), { recursive: true, force: true });
      await mkdir(join(dir, 'records'));
    },
    async warm() {
      await stubs.mode('json', { stdout: '{}' });
      for (const name of names) {
        await new Promise<void>((resolve, reject) => {
          execFile(join(bin, name), [], { cwd: dir }, (error) => {
            if (error === null) resolve();
            else reject(new Error(`warming ${name} failed`, { cause: error }));
          });
        });
      }
      await stubs.clear();
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  return stubs;
}

/** Whether a process exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Polls until `check` holds or `ms` pass; returns its last answer. */
export async function eventually(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
