// Where Claude Code keeps the user's configuration (ADR-037): `$CLAUDE_CONFIG_DIR`
// when it is set, `~/.claude` otherwise. Claude Code itself refuses a relative
// CLAUDE_CONFIG_DIR, so diffcity does too. The tests point CLAUDE_CONFIG_DIR at
// a temporary directory and never reach the real ~/.claude.

import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * The Claude Code configuration directory for `env`. An empty CLAUDE_CONFIG_DIR
 * counts as unset; the home is `env.HOME` when it is an absolute path, else
 * os.homedir(). Throws on a relative CLAUDE_CONFIG_DIR.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const override = env[CLAUDE_CONFIG_DIR_ENV];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(`${CLAUDE_CONFIG_DIR_ENV} must be an absolute path, got ${JSON.stringify(override)}`);
    }
    return normalize(override);
  }
  const home = env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : homedir();
  return join(home, '.claude');
}
