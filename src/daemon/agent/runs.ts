// The agent runs of the daemon (ADR-029): at most one per change and
// AGENT_MAX_RUNS in all, each through the ADR-032 tool runner with the claude
// profile: no shell, its own process group, the allow-listed environment, the
// summary on stdin, the output streamed to `<home>/runs/<changeId>-<runId>.log`
// (0600, capped at AGENT_LOG_CAP). A run ends in one `agent-run` event (the
// summary only as its hash) and an SSE `agent-run` signal. stopAll() is the
// daemon's shutdown: SIGTERM to every group, SIGKILL after the grace;
// killAllNow() is the last resort on process exit.

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_PROFILE, createLimiter, runToolDetailed, type ToolArgs, type ToolContext } from '../../core/exec/index.js';
import { resultSessionId, type AgentMode } from '../../core/agent/index.js';
import type { Db } from '../../core/db/index.js';
import type { AgentRunState, SseEvent } from '../../core/model/types.js';
import type { Logger } from '../log.js';

/** Agent runs at once in the daemon (ADR-029). */
export const AGENT_MAX_RUNS = 2;
/** The longest a run log grows; past it the agent keeps running and the log says so. */
export const AGENT_LOG_CAP = 10 * 1024 * 1024;
/** Run logs older than this are removed. */
export const AGENT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** `<changeId>-<runId>.log`. */
const LOG_NAME = /^[1-9][0-9]*-[0-9a-f]{16}\.log$/;

export interface AgentRunInput {
  changeId: number;
  repoId: number;
  mode: AgentMode;
  args: ToolArgs;
  /** The confirmed binary; any other resolution at run time is refused. */
  binary: string;
  /** The working tree (realpath). */
  cwd: string;
  sessionId: string | null;
  summary: string;
  summaryHash: string;
  timeoutMinutes: number;
  toolContext: ToolContext;
}

/** The parsed claude result: its session id when there is one, and whether it reports an error. */
interface ClaudeResult {
  sessionId: string | null;
  isError: boolean;
}

function parseResult(json: unknown): ClaudeResult | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  return { sessionId: resultSessionId(json), isError: (json as Record<string, unknown>)['is_error'] === true };
}

export interface AgentRunsDeps {
  db: Db;
  /** `<home>/runs`. */
  runsDir: string;
  broadcast(event: SseEvent): void;
  log: Logger;
  now(): Date;
  /** Between SIGTERM and SIGKILL; the claude profile's (10 s) when absent. Tests shorten it. */
  killGraceMs?: number;
  /** Milliseconds per minute of `timeoutMinutes`; 60 000 when absent. Tests shorten it. */
  minuteMs?: number;
}

export interface AgentRuns {
  /** Whether a run may start for the change: null, or what is in the way. */
  busy(changeId: number): 'change' | 'daemon' | null;
  /** Starts a run; throws when busy(changeId) is not null. Returns the run id at once. */
  start(input: AgentRunInput): string;
  /** Stops every run (SIGTERM, then SIGKILL after the grace) and waits for them to be recorded. */
  stopAll(): Promise<void>;
  /** SIGKILL to every running group, synchronously: for process exit. */
  killAllNow(): void;
  /** Removes run logs older than AGENT_LOG_RETENTION_MS; returns how many. */
  purge(): Promise<number>;
  /** Runs in progress. */
  readonly active: number;
  /** Settles once every run started so far has been recorded. */
  idle(): Promise<void>;
}

interface Running {
  changeId: number;
  controller: AbortController;
  pid: number | null;
  done: Promise<void>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAgentRuns(deps: AgentRunsDeps): AgentRuns {
  const running = new Map<string, Running>();
  // Its own limit, not the gh limiter's (ADR-029 decision 2); busy() refuses before it would ever queue.
  const limiter = createLimiter(AGENT_MAX_RUNS, 1);

  const busy = (changeId: number): 'change' | 'daemon' | null => {
    for (const run of running.values()) if (run.changeId === changeId) return 'change';
    return running.size >= AGENT_MAX_RUNS ? 'daemon' : null;
  };

  /** `<home>/runs`, created 0700; refused when it is a link or not a directory. */
  const runsDir = async (): Promise<string> => {
    await mkdir(deps.runsDir, { recursive: true, mode: 0o700 });
    const info = await lstat(deps.runsDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${deps.runsDir} is not a plain directory`);
    return deps.runsDir;
  };

  const header = (input: AgentRunInput, runId: string, at: string): string =>
    [
      `diffcity agent run ${runId}`,
      `change: ${String(input.changeId)}`,
      `mode: ${input.mode}`,
      `argv: ${JSON.stringify([input.binary, ...input.args.argv])}`,
      `cwd: ${input.cwd}`,
      `session: ${input.sessionId ?? 'new'}`,
      `started: ${at}`,
      `summary sha256: ${input.summaryHash}`,
      '--- summary (stdin) ---',
      input.summary.endsWith('\n') ? input.summary.slice(0, -1) : input.summary,
      '--- output ---',
      '',
    ].join('\n');

  const signal = (input: AgentRunInput, runId: string, state: AgentRunState): void => {
    deps.broadcast({ event: 'agent-run', data: { changeId: input.changeId, runId, state } });
  };

  const execute = async (input: AgentRunInput, runId: string, entry: Running): Promise<void> => {
    const startedAt = deps.now().toISOString();
    const name = `${String(input.changeId)}-${runId}.log`;
    let state: AgentRunState = 'failed';
    let exitCode: number | null = null;
    let durationMs = 0;
    let resultSession: string | null = null;
    let truncated = false;
    let message: string | null = null;
    try {
      const path = join(await runsDir(), name);
      // `wx`: a new file, never an existing one or a link; 0600 whatever the umask.
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(header(input, runId, startedAt), 'utf8');
      } finally {
        await handle.close();
      }
      signal(input, runId, 'running');
      const run = await runToolDetailed(
        CLAUDE_PROFILE,
        input.args,
        {
          cwd: input.cwd,
          repo: `change:${String(input.changeId)}`,
          timeoutMs: input.timeoutMinutes * (deps.minuteMs ?? 60_000),
          input: input.summary,
          parse: parseResult,
          sink: { path, capBytes: AGENT_LOG_CAP },
          signal: entry.controller.signal,
          binary: input.binary,
          onSpawn: (pid) => {
            entry.pid = pid;
          },
        },
        {
          ...input.toolContext,
          log: { info: (line) => { deps.log.info(line); }, warn: (line) => { deps.log.warn(line); } },
          limiter,
          ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
        },
      );
      exitCode = run.exitCode;
      durationMs = run.durationMs;
      truncated = run.truncated;
      resultSession = run.result?.sessionId ?? null;
      if (run.stopped === 'timeout') state = 'timeout';
      // Stopped by the daemon, including before claude had started.
      else if (run.stopped === 'aborted' || (entry.controller.signal.aborted && run.exitCode === null)) state = 'stopped';
      else if (run.outcome.kind === 'ok' && !run.outcome.value.isError) state = 'done';
      if (run.outcome.kind !== 'ok') message = run.outcome.message;
      else if (run.outcome.value.isError) message = 'claude reported an error';
    } catch (error) {
      message = errorText(error);
      deps.log.warn(`agent run ${runId} of change ${String(input.changeId)} could not start: ${message}`);
    }
    try {
      deps.db.events.add({
        repoId: input.repoId,
        changeId: input.changeId,
        type: 'agent-run',
        at: deps.now().toISOString(),
        payload: {
          runId,
          state,
          mode: input.mode,
          // The summary never is in the argv; its hash stands for the stdin.
          argv: [input.binary, ...input.args.argv],
          summaryHash: input.summaryHash,
          cwd: input.cwd,
          sessionId: input.sessionId,
          startedAt,
          exitCode,
          durationMs,
          resultSessionId: resultSession,
          logTruncated: truncated,
          log: name,
          message,
        },
      });
    } catch (error) {
      deps.log.error(`agent run ${runId}: the agent-run event was not recorded: ${errorText(error)}`);
    }
    signal(input, runId, state);
  };

  const purge = async (): Promise<number> => {
    let names: string[];
    try {
      names = await readdir(deps.runsDir);
    } catch {
      return 0;
    }
    const cutoff = deps.now().getTime() - AGENT_LOG_RETENTION_MS;
    let removed = 0;
    for (const name of names) {
      if (!LOG_NAME.test(name)) continue;
      const path = join(deps.runsDir, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        await unlink(path);
        removed++;
      } catch {
        // Gone meanwhile.
      }
    }
    return removed;
  };

  return {
    busy,
    purge,
    start(input) {
      const blocked = busy(input.changeId);
      if (blocked !== null) throw new Error(blocked === 'change' ? 'an agent is already running for this change' : 'two agents are already running');
      const runId = randomBytes(8).toString('hex');
      const entry: Running = { changeId: input.changeId, controller: new AbortController(), pid: null, done: Promise.resolve() };
      running.set(runId, entry);
      entry.done = execute(input, runId, entry).finally(() => {
        running.delete(runId);
      });
      void purge();
      return runId;
    },
    async stopAll() {
      const all = [...running.values()];
      for (const run of all) run.controller.abort();
      await Promise.all(all.map((run) => run.done));
    },
    killAllNow() {
      for (const run of running.values()) {
        if (run.pid === null) continue;
        try {
          process.kill(-run.pid, 'SIGKILL');
        } catch {
          // The group is gone.
        }
      }
    },
    get active() {
      return running.size;
    },
    async idle() {
      await Promise.all([...running.values()].map((run) => run.done));
    },
  };
}
