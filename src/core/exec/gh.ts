// gh through the hardened runner (ADR-032). The gh call sites (the PR list,
// the PR state, the default branch for base detection) take a CommandRunner,
// which tests replace with a fake; the real one is this adapter over runTool.
// It runs only gh, only with an argv one of the gh builders makes, and gives
// the call sites what they had before: stdout on success, an error with
// `code: 'ENOENT'` when gh is missing and `killed: true` on a timeout.

import type { CommandRunner } from '../git/exec.js';
import { homePaths, resolveHome } from '../home.js';
import { readToolSetting } from '../settings/settings.js';
import { GH_PR_LIST_ARGV, GH_PROFILE, ghArgsFrom } from './profiles.js';
import { runTool, type ToolContext, type ToolFailure } from './tool.js';

/** A gh call that gave no result; `kind` says why (ToolOutcome). */
export class ToolCallError extends Error {
  readonly kind: ToolFailure;
  /** `ENOENT` when the binary is missing, `ETIMEDOUT` on a timeout. */
  readonly code: string | undefined;
  /** True on a timeout, as for execFile. */
  readonly killed: boolean;

  constructor(kind: ToolFailure, message: string) {
    super(message);
    this.name = 'ToolCallError';
    this.kind = kind;
    this.code = kind === 'missing' ? 'ENOENT' : kind === 'timeout' ? 'ETIMEDOUT' : undefined;
    this.killed = kind === 'timeout';
  }
}

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The JSON shape of each gh call; the call sites check the fields. */
function shapeFor(argv: readonly string[]): (json: unknown) => boolean {
  return argv[1] === GH_PR_LIST_ARGV[1] && argv[0] === GH_PR_LIST_ARGV[0] ? Array.isArray : isObject;
}

/**
 * settings.tools from the diffcity home of this process, read on every call,
 * so an edit needs no restart. A home that cannot be resolved means no setting.
 */
export function homeToolSetting(env: NodeJS.ProcessEnv = process.env): NonNullable<ToolContext['toolSetting']> {
  return async (name) => {
    let settings: string;
    try {
      settings = homePaths(resolveHome(env)).settings;
    } catch {
      return { kind: 'unset' };
    }
    return readToolSetting(settings, name);
  };
}

/** A CommandRunner that runs gh through runTool with `context`. */
export function createGhRunner(context: ToolContext = {}): CommandRunner {
  return async (file, args, options) => {
    if (file !== GH_PROFILE.name) throw new ToolCallError('error', `only gh runs through this runner, not ${file}`);
    const built = ghArgsFrom(args);
    if (built === null) throw new ToolCallError('error', `not a gh call diffcity makes: ${JSON.stringify(args)}`);
    const shape = shapeFor(built.argv);
    const outcome = await runTool(
      GH_PROFILE,
      built,
      { cwd: options.cwd, timeoutMs: options.timeoutMs, parse: (json) => (shape(json) ? json : undefined) },
      context,
    );
    if (outcome.kind !== 'ok') throw new ToolCallError(outcome.kind, outcome.message);
    return JSON.stringify(outcome.value);
  };
}

/** gh for the CLI and anything without a daemon context: settings.tools from the home, no log. */
export const defaultRunner: CommandRunner = createGhRunner({ toolSetting: homeToolSetting() });
