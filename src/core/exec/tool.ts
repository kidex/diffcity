// The hardened runner every external tool goes through (ADR-032): gh today,
// claude for "send review to the agent" (ADR-029), npm, semgrep and gitleaks
// later. git keeps its own runner (src/core/git/exec.ts).
//
// - Binary: `settings.tools.<name>` when set, else the PATH (resolve.ts); one
//   that resolves inside a registered repo, or inside the repo of the call, is
//   refused, which blocks `node_modules/.bin` and `./bin` shims.
// - Execution: spawn without a shell, in its own process group, stdin closed
//   (or the given input, for a profile that reads it); the argv comes from a
//   profile's builder (profiles.ts), from validated values only.
// - Environment: an allow-list plus the git guards (env.ts).
// - Limits: the profile's timeout, then SIGTERM to the group and SIGKILL after
//   5 s; stdout capped at 16 MiB and stderr at 64 KiB; two tool processes at
//   once in the process, one per repo (limiter.ts).
// - Outcome: a closed union. `ok` carries the parsed JSON once the caller's
//   schema accepted it; unparseable or unexpected output is an `error`, never a pass.
// - Logging: argv, cwd, outcome, exit code and duration; stderr only after the
//   session redactor (ADR-038) has been over it, in the log and in messages alike.

import { spawn } from 'node:child_process';
import type { ToolSetting } from '../settings/settings.js';
import { createRedactor } from '../session/redact.js';
import { toolEnv } from './env.js';
import { createLimiter, type Limiter } from './limiter.js';
import { findOnPath, forgetBinary, isInside, realOrSelf } from './resolve.js';

export type ToolName = 'gh' | 'claude';

/** Why a tool gave no result. */
export type ToolFailure = 'missing' | 'unavailable' | 'offline' | 'timeout' | 'error';

/**
 * - `missing`: the binary was not found;
 * - `unavailable`: the tool cannot answer here (not authenticated, no GitHub remote, a closed gate);
 * - `offline`: the tool could not reach its service;
 * - `timeout`: stopped at the profile's timeout;
 * - `error`: anything else, with a message (a refused binary, a cap, unreadable output).
 */
export type ToolOutcome<T> = { kind: 'ok'; value: T } | { kind: ToolFailure; message: string };

export interface ToolProfile {
  readonly name: ToolName;
  /** The longest a call may run; a call may ask for less. */
  readonly timeoutMs: number;
  /** Variables kept for this tool on top of COMMON_ENV (env.ts). */
  readonly env: readonly string[];
  /** `input`: the call may write a string to stdin; `closed`: stdin is never open. */
  readonly stdin: 'closed' | 'input';
  /** The kind of a non-zero exit, from the redacted stderr. */
  classify(stderr: string): 'unavailable' | 'offline' | 'error';
}

/** An argv built by a profile's builder (profiles.ts) from validated values. */
export interface ToolArgs {
  readonly tool: ToolName;
  readonly argv: readonly string[];
}

/** Only the profile builders call this; every value they pass in has been validated. */
export function toolArgs(profile: ToolProfile, argv: readonly string[]): ToolArgs {
  return Object.freeze({ tool: profile.name, argv: Object.freeze([...argv]) });
}

export interface ToolCall<T> {
  /** Where the tool runs: a repo or one of its working trees. */
  cwd: string;
  /** The repo the call is for, for the one-per-repo limit; defaults to cwd. */
  repo?: string;
  /** Shorter than the profile's timeout when the caller needs it; never longer. */
  timeoutMs?: number;
  /** Written to stdin; only for a profile whose stdin is `input`. */
  input?: string;
  /** Checks the parsed JSON; undefined rejects it as unexpected output. */
  parse(json: unknown): T | undefined;
}

export interface ToolLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface ToolContext {
  /** The environment the allow-list is taken from; process.env by default. */
  env?: Readonly<Record<string, string | undefined>>;
  /** `settings.tools.<name>`, checked on disk; unset when omitted. */
  toolSetting?: (name: ToolName) => Promise<ToolSetting>;
  /** Registered repo roots: a binary inside any of them is refused. */
  repoRoots?: () => readonly string[] | Promise<readonly string[]>;
  /** daemon.log; nothing is logged when omitted. */
  log?: ToolLog;
  /** Defaults to the process-wide limiter. */
  limiter?: Limiter;
  /** Between SIGTERM and SIGKILL; TOOL_KILL_GRACE_MS by default (tests shorten it). */
  killGraceMs?: number;
}

export const TOOL_STDOUT_CAP = 16 * 1024 * 1024;
export const TOOL_STDERR_CAP = 64 * 1024;
export const TOOL_KILL_GRACE_MS = 5000;

/**
 * Set by the test setup to a directory (the temporary directory): a binary
 * outside it is refused, so no test can start a real gh, npm or claude even
 * through an explicit PATH.
 */
export const TEST_TOOLS_ENV = 'DIFFCITY_TEST_TOOLS';

/** Two tool processes at once in this process, one per repo. */
const sharedLimiter = createLimiter();

const redactStderr = createRedactor();

/** How long the pipes may stay open after SIGKILL went to the group. */
const PIPE_GRACE_MS = 1000;

/** How much redacted stderr goes into a message or a log line. */
const STDERR_SHOWN = 2000;

type Exec =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string }
  | { kind: 'spawn-error'; code: string | undefined; message: string; stderr: string }
  | { kind: 'stopped'; why: 'timeout' | 'stdout-cap' | 'stderr-cap'; stderr: string };

interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  input: string | undefined;
  timeoutMs: number;
  graceMs: number;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    // A negative pid is the process group: the tool and everything it started.
    process.kill(-pid, signal);
  } catch {
    // The group is gone already.
  }
}

function execute(binary: string, argv: readonly string[], options: ExecOptions): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...argv], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let stopped: 'timeout' | 'stdout-cap' | 'stderr-cap' | null = null;
    let settled = false;

    const stderrText = (): string => Buffer.concat(stderr).toString('utf8');
    const finish = (result: Exec): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const stop = (why: 'timeout' | 'stdout-cap' | 'stderr-cap'): void => {
      if (stopped !== null) return;
      stopped = why;
      killGroup(child.pid, 'SIGTERM');
      // Whatever ignores SIGTERM in the group goes after the grace period, even once the tool itself has exited.
      setTimeout(() => {
        killGroup(child.pid, 'SIGKILL');
        // A process that left the group (setsid) can hold the pipes open: stop waiting for them.
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ kind: 'stopped', why, stderr: stderrText() });
        }, PIPE_GRACE_MS);
      }, options.graceMs);
    };
    const timer = setTimeout(() => {
      stop('timeout');
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stopped !== null) return;
      stdoutSize += chunk.length;
      if (stdoutSize > TOOL_STDOUT_CAP) stop('stdout-cap');
      else stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stopped !== null) return;
      stderrSize += chunk.length;
      if (stderrSize > TOOL_STDERR_CAP) stop('stderr-cap');
      else stderr.push(chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ kind: 'spawn-error', code: error.code, message: error.message, stderr: stderrText() });
    });
    child.on('close', (code, signal) => {
      if (stopped !== null) finish({ kind: 'stopped', why: stopped, stderr: stderrText() });
      else finish({ kind: 'exit', code, signal, stdout: Buffer.concat(stdout), stderr: stderrText() });
    });
    if (options.input !== undefined && child.stdin !== null) {
      // The tool may exit before reading its input; the exit code reports that.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

/** The first lines of redacted stderr, for a message. */
function shown(stderr: string): string {
  const text = stderr.trim();
  return text.length > STDERR_SHOWN ? `${text.slice(0, STDERR_SHOWN)}...` : text;
}

/** The binary to run, or the outcome that stops the call. */
async function locate(profile: ToolProfile, cwd: string, context: ToolContext, env: Readonly<Record<string, string | undefined>>): Promise<{ binary: string } | { kind: ToolFailure; message: string }> {
  const name = profile.name;
  const setting: ToolSetting = (await context.toolSetting?.(name)) ?? { kind: 'unset' };
  let binary: string;
  if (setting.kind === 'invalid') return { kind: 'error', message: `settings: ${setting.message}` };
  if (setting.kind === 'path') {
    binary = await realOrSelf(setting.path);
  } else {
    const found = await findOnPath(name, env.PATH);
    if (found === null) return { kind: 'missing', message: `${name} not found on the PATH` };
    binary = found;
  }
  const roots = await Promise.all([...((await context.repoRoots?.()) ?? []), cwd].map(realOrSelf));
  const inside = roots.find((root) => isInside(binary, root));
  if (inside !== undefined) {
    return { kind: 'error', message: `${name} resolves to ${binary}, inside the repo ${inside}; refused` };
  }
  // A property of the process, never of the call: a call's own env must not turn the sandbox off.
  const sandbox = process.env[TEST_TOOLS_ENV];
  if (sandbox !== undefined && sandbox !== '' && !isInside(binary, await realOrSelf(sandbox))) {
    return { kind: 'error', message: `${name} resolves to ${binary}, outside the test tool sandbox; refused` };
  }
  return { binary };
}

function interpret<T>(profile: ToolProfile, result: Exec, call: ToolCall<T>, stderr: string): ToolOutcome<T> {
  const name = profile.name;
  switch (result.kind) {
    case 'spawn-error':
      if (result.code === 'ENOENT') return { kind: 'missing', message: `${name} not found: ${result.message}` };
      return { kind: 'error', message: `${name} could not start: ${result.message}` };
    case 'stopped':
      if (result.why === 'timeout') return { kind: 'timeout', message: `${name} did not answer in time` };
      return { kind: 'error', message: `${name} wrote more than ${result.why === 'stdout-cap' ? '16 MiB to stdout' : '64 KiB to stderr'}` };
    case 'exit': {
      if (result.code !== 0) {
        const how = result.code === null ? `was killed by ${String(result.signal)}` : `exited with code ${String(result.code)}`;
        const detail = shown(stderr);
        return { kind: profile.classify(stderr), message: detail === '' ? `${name} ${how}` : `${name} ${how}: ${detail}` };
      }
      let json: unknown;
      try {
        json = JSON.parse(result.stdout.toString('utf8'));
      } catch {
        return { kind: 'error', message: `${name} answered something that is not JSON` };
      }
      const value = call.parse(json);
      if (value === undefined) return { kind: 'error', message: `${name} answered unexpected JSON` };
      return { kind: 'ok', value };
    }
  }
}

/** Runs one tool call; never throws. */
export async function runTool<T>(profile: ToolProfile, args: ToolArgs, call: ToolCall<T>, context: ToolContext = {}): Promise<ToolOutcome<T>> {
  const env = context.env ?? process.env;
  const log = (outcome: ToolOutcome<T>, exitCode: number | null, durationMs: number, stderr: string): void => {
    if (context.log === undefined) return;
    const parts = [
      `tool ${profile.name}`,
      `argv=${JSON.stringify(args.argv)}`,
      `cwd=${call.cwd}`,
      `outcome=${outcome.kind}`,
      `exit=${exitCode === null ? '-' : String(exitCode)}`,
      `duration=${String(durationMs)}ms`,
    ];
    if (outcome.kind !== 'ok') parts.push(`message=${JSON.stringify(outcome.message)}`);
    else if (stderr.trim() !== '') parts.push(`stderr=${JSON.stringify(shown(stderr))}`);
    if (outcome.kind === 'ok') context.log.info(parts.join(' '));
    else context.log.warn(parts.join(' '));
  };

  const refuse = (message: string): ToolOutcome<T> => {
    const outcome: ToolOutcome<T> = { kind: 'error', message };
    log(outcome, null, 0, '');
    return outcome;
  };
  if (args.tool !== profile.name) return refuse(`arguments built for ${args.tool} cannot run ${profile.name}`);
  if (call.input !== undefined && profile.stdin !== 'input') return refuse(`${profile.name} takes no input`);

  const located = await locate(profile, call.cwd, context, env);
  if (!('binary' in located)) {
    log(located, null, 0, '');
    return located;
  }
  const limiter = context.limiter ?? sharedLimiter;
  return limiter.run(call.repo ?? call.cwd, async () => {
    const started = performance.now();
    const result = await execute(located.binary, args.argv, {
      cwd: call.cwd,
      env: toolEnv(profile.env, env),
      input: call.input,
      timeoutMs: Math.min(call.timeoutMs ?? profile.timeoutMs, profile.timeoutMs),
      graceMs: context.killGraceMs ?? TOOL_KILL_GRACE_MS,
    });
    const duration = Math.round(performance.now() - started);
    if (result.kind === 'spawn-error' && result.code === 'ENOENT') forgetBinary(profile.name, env.PATH);
    const stderr = redactStderr(result.stderr);
    const outcome = interpret(profile, result, call, stderr);
    log(outcome, result.kind === 'exit' ? result.code : null, duration, stderr);
    return outcome;
  });
}
