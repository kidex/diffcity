// The environment of a tool (ADR-032): an allow-list plus the ADR-024 guards.

import { devNull } from 'node:os';
import { describe, expect, it } from 'vitest';
import { GH_PROFILE, absolutePathEntries, toolEnv } from '../../../src/core/exec/index.js';

describe('toolEnv', () => {
  it('tool/env-allowlist: keeps the common and profile variables, LC_* included, and drops the rest', () => {
    const env = toolEnv(GH_PROFILE.env, {
      PATH: '/bin',
      HOME: '/home/sample',
      LC_CTYPE: 'en_US.UTF-8',
      GH_TOKEN: 'tok-1',
      GH_CONFIG_DIR: '/home/sample/.gh',
      NODE_OPTIONS: '--require /elsewhere/hook.js',
      GIT_DIR: '/elsewhere',
      npm_config_cache: '/elsewhere/cache',
      UNSET: undefined,
    });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/sample');
    expect(env.LC_CTYPE).toBe('en_US.UTF-8');
    expect(env.GH_TOKEN).toBe('tok-1');
    expect(env.GH_CONFIG_DIR).toBe('/home/sample/.gh');
    for (const dropped of ['NODE_OPTIONS', 'GIT_DIR', 'npm_config_cache', 'UNSET']) expect(env, dropped).not.toHaveProperty(dropped);
  });

  it('npm variables pass only for a profile that lists them', () => {
    expect(toolEnv(['npm_config_cache'], { npm_config_cache: '/cache' }).npm_config_cache).toBe('/cache');
  });

  it('carries every ADR-024 guard, over anything the daemon had', () => {
    const env = toolEnv(GH_PROFILE.env, {
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/elsewhere/hook',
      GIT_ALLOW_PROTOCOL: 'ext',
      GIT_TERMINAL_PROMPT: '1',
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: devNull,
      GIT_ALLOW_PROTOCOL: '',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
    });
  });
});

describe('PATH entries', () => {
  it('tool/relative-path-entry-skipped: empty, `.` and relative entries are dropped', () => {
    expect(absolutePathEntries('::.:bin:./node_modules/.bin:/usr/local/bin:../x:/bin:')).toEqual(['/usr/local/bin', '/bin']);
    expect(absolutePathEntries(undefined)).toEqual([]);
  });
});
