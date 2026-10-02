import { devNull } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ghEnv } from '../../src/core/git/exec.js';

describe('ghEnv', () => {
  it('carries every ADR-024 guard gh needs when it runs git in the repo', () => {
    const env = ghEnv({ PATH: '/bin', GH_TOKEN: 'invented-token' });
    expect(env).toMatchObject({
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
    });
    // The user's own variables pass through; nothing new is added for the token.
    expect(env.PATH).toBe('/bin');
    expect(env.GH_TOKEN).toBe('invented-token');
  });

  it('appends to GIT_CONFIG_COUNT entries already set and keeps them intact', () => {
    const env = ghEnv({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Ada',
      GIT_CONFIG_KEY_1: 'color.ui',
      GIT_CONFIG_VALUE_1: 'never',
    });
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Ada',
      GIT_CONFIG_KEY_1: 'color.ui',
      GIT_CONFIG_VALUE_1: 'never',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'core.hooksPath',
      GIT_CONFIG_VALUE_3: devNull,
    });
  });
});
