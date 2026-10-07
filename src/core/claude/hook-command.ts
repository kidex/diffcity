// How Claude Code calls the CLI (ADR-037): `diffcity` when the `diffcity` on
// the PATH is this very CLI (a global install), otherwise the absolute node
// binary and the absolute CLI entry, each in double quotes. The Stop hook
// command and the slash command's allow-list use the same invocation, so the
// allow-list matches the commands the slash command runs.

import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** The invocation of a global install. */
export const GLOBAL_CLI = 'diffcity';

export interface CliInvocation {
  /** `global` when the `diffcity` on the PATH is the running CLI, `absolute` otherwise. */
  kind: 'global' | 'absolute';
  /** `diffcity`, or `"<absolute node>" "<absolute dist/cli/index.js>"`. */
  cli: string;
}

export type CliInvocationResult = { ok: true; invocation: CliInvocation } | { ok: false; error: string };

export interface ChooseCliOptions {
  /** The PATH the hook will see; the PATH of the shell running setup. */
  pathEnv: string | undefined;
  /** Absolute path of the node binary running the CLI (process.execPath). */
  nodePath: string;
  /** Absolute path of the CLI entry, dist/cli/index.js. */
  cliEntry: string;
}

/**
 * Characters that cannot go in the absolute form: the hook runs through a
 * shell (inside double quotes `"`, `$`, `` ` `` and `\` are special), Claude
 * Code splits `allowed-tools` on parentheses, and the frontmatter is YAML
 * (`: ` and ` #` break a plain value). Control characters are refused too.
 */
const UNSAFE_CHARS = /["$`\\()\p{Cc}]/u;
const UNSAFE_SEQUENCES = [': ', ' #'];

function unsafePart(path: string): string | null {
  const char = UNSAFE_CHARS.exec(path);
  if (char !== null) return JSON.stringify(char[0]);
  const sequence = UNSAFE_SEQUENCES.find((candidate) => path.includes(candidate));
  return sequence === undefined ? null : JSON.stringify(sequence);
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/** The first executable `diffcity` on the PATH, or null. */
async function findOnPath(pathEnv: string | undefined): Promise<string | null> {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, GLOBAL_CLI);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/** Picks the invocation the hook and the slash command use. */
export async function chooseCliInvocation(options: ChooseCliOptions): Promise<CliInvocationResult> {
  const onPath = await findOnPath(options.pathEnv);
  if (onPath !== null && (await sameFile(onPath, options.cliEntry))) {
    return { ok: true, invocation: { kind: 'global', cli: GLOBAL_CLI } };
  }
  for (const path of [options.nodePath, options.cliEntry]) {
    if (!isAbsolute(path)) return { ok: false, error: `${JSON.stringify(path)} is not an absolute path` };
    const unsafe = unsafePart(path);
    if (unsafe !== null) {
      return {
        ok: false,
        error: `cannot use ${JSON.stringify(path)} in the hook command: it contains ${unsafe}; install diffcity globally (npm i -g diffcity) and run setup-claude again`,
      };
    }
  }
  return { ok: true, invocation: { kind: 'absolute', cli: `"${options.nodePath}" "${options.cliEntry}"` } };
}

/** The Stop hook command for an invocation. */
export function hookCommand(cli: string): string {
  return `${cli} track --agent`;
}
