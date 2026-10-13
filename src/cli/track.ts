// `diffcity track [<dir>] [--agent]` (SPEC.md section 3, 3a C2/C3, ADR-016, ADR-001).
// The shell hook runs this on every repo entry, so the module stays light: it
// may load the socket client, src/core/home and the git identity probe, never
// the parser (web-tree-sitter) or src/core/report.
// test/integration/cli/track-lazy-imports guards that.

import { resolve } from 'node:path';
import { identifyRepo } from '../core/changes/identity.js';
import { MAX_HOOK_INPUT_BYTES, endsSession, parseAgentHookInput, type AgentHookInput } from '../core/changes/hook-input.js';
import { ensureHome, homePaths, resolveHome } from '../core/home.js';
import type { SocketRequest, TrackSession } from '../core/model/types.js';
import { requestWithAutostart, type SpawnDaemonOptions, type SpawnedDaemon } from '../daemon/client.js';
import { readStdin } from './stdin.js';

export interface TrackCommandOptions {
  agent?: boolean;
}

/** The process stdin as track sees it. */
export interface TrackStdin {
  isTTY: boolean;
  /** Reads at most `maxBytes` + 1 bytes, so an oversized input is still recognised as such. */
  read: (maxBytes: number) => Promise<string>;
}

export interface TrackDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to process.stdin. */
  stdin?: TrackStdin;
  /** Starts a detached daemon; defaults to spawnDaemon from the socket client. */
  spawnDaemon?: (options: SpawnDaemonOptions) => SpawnedDaemon;
  startTimeoutMs?: number;
  now?: () => Date;
}

const processStdin: TrackStdin = {
  get isTTY() {
    return process.stdin.isTTY;
  },
  read: (maxBytes) => readStdin(process.stdin, maxBytes),
};

/**
 * The Stop hook input, read only for --agent when stdin is not a TTY
 * (SPEC.md section 3). An invalid input is reported and ignored: the agent
 * mark still goes through for the default directory.
 */
async function readHookInput(stdin: TrackStdin, warn: (message: string) => void): Promise<AgentHookInput | null> {
  if (stdin.isTTY) return null;
  let text: string;
  try {
    text = await stdin.read(MAX_HOOK_INPUT_BYTES);
  } catch (error) {
    warn(`ignoring stdin: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const parsed = parseAgentHookInput(text);
  if (!parsed.ok) {
    warn(`ignoring stdin: ${parsed.error}`);
    return null;
  }
  return parsed.input;
}

/**
 * The `track` socket request for an absolute repo directory; `start` sends it
 * too. `session` goes with `--agent` when the hook JSON was valid (ADR-038).
 */
export function trackRequest(dir: string, agent: boolean, at: Date, session?: TrackSession): Extract<SocketRequest, { type: 'track' }> {
  return { v: 1, type: 'track', dir, agent, at: at.toISOString(), ...(session === undefined ? {} : { session }) };
}

/**
 * Runs the command; resolves with the process exit code (0 or 1). With
 * --agent it is the Claude Code Stop hook, which must never block the agent
 * (ADR-037): every failure prints one line on stderr and exits 0.
 */
export async function runTrack(dirArg: string | undefined, options: TrackCommandOptions, deps: TrackDeps): Promise<number> {
  const { io } = deps;
  const agent = options.agent === true;
  const fail = (message: string): number => {
    io.stderr(`diffcity track: ${message.replace(/\s*\n\s*/g, ' ').trim()}\n`);
    return agent ? 0 : 1;
  };
  const cwd = deps.cwd ?? process.cwd();

  // The hook JSON carries the session (session_id, transcript_path, the event)
  // and the cwd that replaces the default <dir>. The four fields are forwarded
  // as they came: the daemon validates them before it reads anything, and this
  // module never loads the session parser (ADR-038).
  const hook = agent ? await readHookInput(deps.stdin ?? processStdin, (message) => { io.stderr(`diffcity track: ${message}\n`); }) : null;
  const dir = dirArg !== undefined ? resolve(cwd, dirArg) : (hook?.cwd ?? cwd);

  // Checked here so a directory outside a repo never starts a daemon.
  try {
    await identifyRepo(dir);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const env = deps.env ?? process.env;
  let paths;
  try {
    paths = homePaths(resolveHome(env));
    await ensureHome(paths.home);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const result = await requestWithAutostart(
    paths,
    trackRequest(
      dir,
      agent,
      deps.now?.() ?? new Date(),
      hook === null ? undefined : { sessionId: hook.sessionId, transcriptPath: hook.transcriptPath, cwd: hook.cwd, event: hook.event },
    ),
    {
      env,
      ...(deps.spawnDaemon === undefined ? {} : { spawn: deps.spawnDaemon }),
      ...(deps.startTimeoutMs === undefined ? {} : { timeoutMs: deps.startTimeoutMs }),
    },
  );
  if (!result.ok) return fail(result.error);
  const { response } = result;
  if (!response.ok) return fail(response.error);
  // A SessionEnd only ended the session in the daemon (DC-128): no agent mark, no collection.
  io.stdout(hook !== null && endsSession(hook.event) ? `session ended in ${response.repo.name}\n` : `tracked ${response.repo.name}\n`);
  return 0;
}
