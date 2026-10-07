// `diffcity setup-claude [--repo [<dir>]] [--dry-run] [--remove]` (SPEC.md
// sections 3 and 7, ADR-037). Installs the `/diffcity-review` command file and the
// Stop hook in the user's Claude Code configuration (`$CLAUDE_CONFIG_DIR` or
// `~/.claude`), or in `<repo>/.claude` with --repo. The work is in
// src/core/claude; this module picks the target and prints what changed.
//
// The module stays light: it loads src/core/claude (file and JSON code) and
// the git root probe, never the parser (web-tree-sitter, ts-morph),
// src/core/report or src/core/parse.
// test/integration/cli/track-lazy-imports guards that.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_CODE_CHECKED_VERSION,
  applyPlan,
  chooseCliInvocation,
  claudeConfigDir,
  claudeTarget,
  planInstall,
  planRemove,
  type ClaudeTarget,
  type PlannedFile,
  type SetupPlan,
} from '../core/claude/index.js';
import { findRepoRoot } from '../core/git/change.js';

export interface SetupClaudeOptions {
  /** `true` for the repo containing the current directory, a directory for that repo's. */
  repo?: string | boolean;
  dryRun?: boolean;
  remove?: boolean;
}

export interface SetupClaudeDeps {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** The node binary the hook runs; defaults to process.execPath. */
  nodePath?: string;
  /** The CLI entry the hook runs; defaults to this build's dist/cli/index.js. */
  cliEntry?: string;
}

/** dist/cli/index.js of the running build. */
const defaultCliEntry = (): string => fileURLToPath(new URL('./index.js', import.meta.url));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function describe(file: PlannedFile, dryRun: boolean, remove: boolean): string {
  switch (file.action) {
    case 'create':
      return `${dryRun ? 'would create' : 'created'} ${file.path}`;
    case 'update': {
      const verb = `${dryRun ? 'would update' : 'updated'} ${file.path}`;
      if (file.kind === 'command') return verb;
      return `${verb} (${remove ? 'Stop hook removed' : 'Stop hook added'})`;
    }
    case 'delete':
      return `${dryRun ? 'would delete' : 'deleted'} ${file.path}`;
    case 'unchanged':
      if (file.kind === 'command') return `unchanged ${file.path}`;
      return `unchanged ${file.path} (${remove ? 'no diffcity Stop hook' : 'the Stop hook is already there'})`;
    case 'absent':
      return `absent ${file.path}`;
    case 'kept':
      return `kept ${file.path} (not written by diffcity)`;
  }
}

function report(plan: SetupPlan, dryRun: boolean, remove: boolean, out: (line: string) => void): void {
  if (plan.backup !== null) out(`${dryRun ? 'would back up' : 'backed up'} ${plan.backup.from} to ${plan.backup.to}`);
  for (const file of plan.files) out(describe(file, dryRun, remove));
  out(`hook command: ${plan.hookCommand}`);
  out(`checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`);
}

async function resolveTarget(options: SetupClaudeOptions, env: NodeJS.ProcessEnv, cwd: string): Promise<ClaudeTarget> {
  if (options.repo === undefined || options.repo === false) return claudeTarget('user', claudeConfigDir(env));
  const dir = options.repo === true ? cwd : resolve(cwd, options.repo);
  return claudeTarget('repo', resolve(await findRepoRoot(dir), '.claude'));
}

/** Runs the command; resolves with the exit code: 0 on success, 1 on a refusal or an error, with the reason. */
export async function runSetupClaude(options: SetupClaudeOptions, deps: SetupClaudeDeps): Promise<number> {
  const { io } = deps;
  const fail = (message: string): number => {
    io.stderr(`diffcity setup-claude: ${message}\n`);
    return 1;
  };
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const dryRun = options.dryRun === true;

  let target: ClaudeTarget;
  try {
    target = await resolveTarget(options, env, cwd);
  } catch (error) {
    return fail(messageOf(error));
  }

  const choice = await chooseCliInvocation({ pathEnv: env.PATH, nodePath: deps.nodePath ?? process.execPath, cliEntry: deps.cliEntry ?? defaultCliEntry() });
  if (!choice.ok) return fail(choice.error);
  const { invocation } = choice;

  const planned = options.remove === true ? await planRemove(target, invocation.cli) : await planInstall(target, invocation.cli);
  if (!planned.ok) return fail(`refused: ${planned.reason}`);
  const { plan } = planned;

  if (!dryRun) {
    try {
      await applyPlan(plan);
    } catch (error) {
      return fail(messageOf(error));
    }
  }
  report(plan, dryRun, options.remove === true, (line) => {
    io.stdout(`${line}\n`);
  });
  if (target.scope === 'repo' && invocation.kind === 'absolute' && options.remove !== true) {
    io.stderr(
      'diffcity setup-claude: warning: the hook command holds absolute paths of this machine; do not commit these files, or install diffcity globally and run setup-claude again\n',
    );
  }
  return 0;
}
