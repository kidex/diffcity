// Stub binaries for the tool runner tests (ADR-032): `#!/bin/sh` scripts on a
// temporary PATH that record their argv, cwd and environment and answer what
// the test wrote to their `mode` and `stdout` files. The runner passes only an
// allow-listed environment, so a stub is steered through files, not variables.
//
// macOS vets the first exec of every freshly written file (syspolicyd), which
// can take seconds under load: the stubs are written once per test file and
// each is run once by `warm()` before the tests start.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StubRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  pid: number;
  /** What the stub read on stdin, for stubs made with `{ stdin: true }`; undefined otherwise. */
  stdin?: string;
}

export interface ToolStubOptions {
  /** The stubs read their stdin to the end and record it (a builtin loop, no extra exec). */
  stdin?: boolean;
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
   * - `orphan-ignore-term`: dies on SIGTERM, leaving a group member that ignores it and holds no pipe;
   * - `flood-stdout` / `flood-stderr`: writes past the runner's caps.
   */
  mode(mode: 'json' | 'fail' | 'sleep' | 'sleep-ignore-term' | 'orphan-ignore-term' | 'flood-stdout' | 'flood-stderr', files?: { stdout?: string; stderr?: string; code?: number }): Promise<void>;
  /** Every call recorded so far, oldest first. */
  records(): Promise<StubRecord[]>;
  /** Forgets the recorded calls. */
  clear(): Promise<void>;
  /** Runs each stub once so the tests do not pay the first-exec check. */
  warm(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * The stub script. Recording and answering use shell builtins only: every
 * extra exec is one more chance for a macOS process-start stall to push a
 * call past its timeout. Only the sleep and flood modes run another program.
 */
function body(dir: string, options: ToolStubOptions): string {
  const q = (path: string): string => `"${join(dir, path)}"`;
  return [
    '#!/bin/sh',
    `rec=${q('records')}/$$`,
    'echo $$ > "$rec.pid"',
    'pwd -P > "$rec.cwd"',
    'export -p > "$rec.env"',
    'for a in "$@"; do printf "%s\\0" "$a"; done > "$rec.argv"',
    ...(options.stdin === true ? [`while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done > "$rec.stdin"`] : []),
    'mode=json',
    `[ -f ${q('mode')} ] && read -r mode < ${q('mode')}`,
    'echo done > "$rec.started"',
    'case "$mode" in',
    `  fail) if [ -s ${q('stderr')} ]; then while IFS= read -r line; do printf '%s\\n' "$line" >&2; done < ${q('stderr')}; fi; read -r code < ${q('code')}; exit "$code" ;;`,
    `  sleep) sleep 600 & echo $! > ${q('grandchild')}; wait ;;`,
    `  sleep-ignore-term) trap '' TERM; sleep 600 & echo $! > ${q('grandchild')}; wait; wait ;;`,
    // The tool dies on SIGTERM; a member of its group ignores it and holds none of its pipes.
    `  orphan-ignore-term) ( trap '' TERM; sleep 600 & echo $! > ${q('grandchild')}; wait ) > /dev/null 2>&1 < /dev/null & wait ;;`,
    '  flood-stdout) head -c 17000000 /dev/zero ;;',
    '  flood-stderr) head -c 70000 /dev/zero >&2 ;;',
    `  *) if [ -s ${q('stdout')} ]; then while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < ${q('stdout')}; fi ;;`,
    'esac',
    '',
  ].join('\n');
}

/** Parses `export -p` (`export NAME="value"`, or `export NAME='value'` from dash). */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^(?:export|declare -x) /, '');
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at);
    let value = line.slice(at + 1);
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/'\\''/g, "'");
    env[name] = value;
  }
  return env;
}

export async function createToolStubs(names: readonly string[] = ['gh'], options: ToolStubOptions = {}): Promise<ToolStubs> {
  const dir = await mkdtemp(join(tmpdir(), 'diffcity-tool-stubs-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await mkdir(join(dir, 'records'));
  for (const name of names) {
    await writeFile(join(bin, name), body(dir, options), 'utf8');
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
      const at = join(dir, 'records');
      const pids = (await readdir(at)).filter((name) => name.endsWith('.started')).map((name) => name.slice(0, -'.started'.length));
      const records = await Promise.all(
        pids.map(async (pid) => {
          const read = (ext: string): Promise<string> => readFile(join(at, `${pid}.${ext}`), 'utf8');
          const argv = (await read('argv').catch(() => '')).split('\0');
          argv.pop();
          const started = (await stat(join(at, `${pid}.started`))).mtimeMs;
          const stdin = options.stdin === true ? await read('stdin').catch(() => undefined) : undefined;
          return { argv, cwd: (await read('cwd')).trim(), env: parseEnv(await read('env')), pid: Number(pid), started, stdin };
        }),
      );
      return records
        .sort((a, b) => a.started - b.started)
        .map(({ argv, cwd, env, pid, stdin }) => ({ argv, cwd, env, pid, ...(stdin === undefined ? {} : { stdin }) }));
    },
    async clear() {
      await rm(join(dir, 'records'), { recursive: true, force: true });
      await mkdir(join(dir, 'records'));
    },
    async warm() {
      await stubs.mode('json', { stdout: '{}' });
      for (const name of names) {
        await new Promise<void>((resolve, reject) => {
          const child = execFile(join(bin, name), [], { cwd: dir }, (error) => {
            if (error === null) resolve();
            else reject(new Error(`warming ${name} failed`, { cause: error }));
          });
          // A stub that reads its stdin waits for its end.
          child.stdin?.end();
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
