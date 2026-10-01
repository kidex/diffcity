import { describe, expect, it } from 'vitest';
import { configEnv, configOverrides, parseScopedConfig } from '../../src/core/git/guard.js';

function entries(...lines: [scope: string, key: string, value: string | null][]): string {
  return lines.map(([scope, key, value]) => `${scope}\0${value === null ? key : `${key}\n${value}`}\0`).join('');
}

describe('parseScopedConfig', () => {
  it('reads scope, key and value, keeping newlines inside values and bare keys as null', () => {
    const output = entries(
      ['global', 'filter.user.clean', 'tool clean %f'],
      ['local', 'filter.a.b.process', 'line one\nline two'],
      ['local', 'filter.x.required', null],
    );
    expect(parseScopedConfig(output)).toEqual([
      { scope: 'global', key: 'filter.user.clean', value: 'tool clean %f' },
      { scope: 'local', key: 'filter.a.b.process', value: 'line one\nline two' },
      { scope: 'local', key: 'filter.x.required', value: null },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseScopedConfig('')).toEqual([]);
  });
});

describe('configOverrides', () => {
  it('disables every filter command the repo sets, and makes its driver optional', () => {
    const parsed = parseScopedConfig(
      entries(
        ['local', 'filter.x.clean', '/opt/evil'],
        ['local', 'filter.x.smudge', '/opt/evil'],
        ['worktree', 'filter.y.process', '/opt/evil'],
        ['local', 'filter.x.required', 'true'],
        ['local', 'filter.x.description', 'not a command'],
      ),
    );
    expect(configOverrides(parsed)).toEqual([
      ['filter.x.clean', ''],
      ['filter.x.smudge', ''],
      ['filter.y.process', ''],
      ['filter.x.required', 'false'],
    ]);
  });

  it('leaves filters only the user config defines alone', () => {
    const parsed = parseScopedConfig(
      entries(['system', 'filter.sys.clean', 'a'], ['global', 'filter.user.process', 'b'], ['command', 'filter.cli.clean', 'c']),
    );
    expect(configOverrides(parsed)).toEqual([]);
  });

  it('restores the last user value of a filter the repo redefines', () => {
    const parsed = parseScopedConfig(
      entries(
        ['system', 'filter.user.clean', 'old-tool clean'],
        ['global', 'filter.user.clean', 'tool clean'],
        ['global', 'filter.user.required', null],
        ['local', 'filter.user.clean', '/opt/evil'],
        ['local', 'filter.user.required', 'false'],
        ['local', 'filter.user.process', '/opt/evil'],
      ),
    );
    expect(configOverrides(parsed)).toEqual([
      ['filter.user.clean', 'tool clean'],
      ['filter.user.required', 'true'],
      ['filter.user.process', ''],
    ]);
  });

  it('lets a command-line value win over the repo, as git does', () => {
    const parsed = parseScopedConfig(
      entries(['local', 'filter.x.clean', '/opt/evil'], ['command', 'filter.x.clean', 'cli-tool']),
    );
    expect(configOverrides(parsed)).toEqual([['filter.x.clean', 'cli-tool']]);
  });

  it('treats an unknown scope as the repo', () => {
    expect(configOverrides(parseScopedConfig(entries(['other', 'filter.x.clean', '/opt/evil'])))).toEqual([
      ['filter.x.clean', ''],
    ]);
  });

  it('refuses every named transport, from any scope', () => {
    const parsed = parseScopedConfig(
      entries(
        ['local', 'protocol.ext.allow', 'always'],
        ['global', 'protocol.file.allow', 'user'],
        ['local', 'protocol.version', '2'],
        ['local', 'protocol.allow', 'always'],
      ),
    );
    expect(configOverrides(parsed)).toEqual([
      ['protocol.ext.allow', 'never'],
      ['protocol.file.allow', 'never'],
    ]);
  });
});

describe('configEnv', () => {
  it('is empty without overrides', () => {
    expect(configEnv([], {})).toEqual({});
  });

  it('numbers overrides from zero, keeping names with "=" whole', () => {
    expect(configEnv([['filter.a=b.clean', '']], {})).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'filter.a=b.clean',
      GIT_CONFIG_VALUE_0: '',
    });
  });

  it('appends after entries the caller already passes', () => {
    expect(configEnv([['filter.x.clean', '']], { GIT_CONFIG_COUNT: '2' })).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'filter.x.clean',
      GIT_CONFIG_VALUE_2: '',
    });
  });
});
