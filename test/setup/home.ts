// vitest setupFiles entry (ADR-015): runs before every test file and points
// DIFFCITY_HOME and HOME at a fresh temporary directory, so a test that forgets
// to pass a home still cannot reach the real ~/.config/diffcity. It points
// CLAUDE_CONFIG_DIR there too, so `setup-claude` never reaches the real
// ~/.claude, even when the tests run inside a Claude Code session that set it
// (ADR-037). Processes the tests spawn inherit the variables through process.env.

import { join } from 'node:path';
import { afterAll } from 'vitest';
import { CLAUDE_CONFIG_DIR_ENV } from '../../src/core/claude/config-dir.js';
import { HOME_ENV } from '../../src/core/home.js';
import { tempHome } from '../helpers/config.js';
import { registerHome } from '../helpers/daemons.js';

const original = { home: process.env[HOME_ENV], userHome: process.env.HOME, claude: process.env[CLAUDE_CONFIG_DIR_ENV] };
const temp = await tempHome();
// A daemon a test starts through the inherited environment is still swept.
registerHome(temp.home);

process.env[HOME_ENV] = temp.home;
process.env.HOME = temp.userHome;
process.env[CLAUDE_CONFIG_DIR_ENV] = join(temp.userHome, '.claude');

afterAll(async () => {
  restore(HOME_ENV, original.home);
  restore('HOME', original.userHome);
  restore(CLAUDE_CONFIG_DIR_ENV, original.claude);
  await temp.cleanup();
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}
