// `agentLaunch` of the user settings (ADR-029): off by default, every key
// validated, and a bad entry turns the launch off without touching the rest of
// the file.

import { describe, expect, it } from 'vitest';
import { agentLaunchSettings, defaultAgentLaunch } from '../../../src/core/agent/index.js';
import { emptySettings, parseSettings } from '../../../src/core/settings/index.js';

const with_ = (agentLaunch: unknown) => agentLaunchSettings({ ...emptySettings(), agentLaunch });

describe('agentLaunch settings', () => {
  it('is off by default, with no repo, no binary, no permission mode and 30 minutes', () => {
    expect(agentLaunchSettings(emptySettings())).toEqual({ ok: true, settings: defaultAgentLaunch() });
    expect(defaultAgentLaunch()).toEqual({ enabled: false, repos: [], claudePath: null, permissionMode: null, timeoutMinutes: 30 });
    expect(with_({})).toEqual({ ok: true, settings: defaultAgentLaunch() });
  });

  it('reads every key', () => {
    expect(with_({ enabled: true, repos: ['/work/sample-shop'], claudePath: '/opt/tools/claude', permissionMode: 'plan', timeoutMinutes: 5 })).toEqual({
      ok: true,
      settings: { enabled: true, repos: ['/work/sample-shop'], claudePath: '/opt/tools/claude', permissionMode: 'plan', timeoutMinutes: 5 },
    });
  });

  it('refuses a bad value of each key, naming it', () => {
    const cases: [unknown, string][] = [
      [[], 'agentLaunch'],
      ['on', 'agentLaunch'],
      [{ enabled: 'yes' }, 'agentLaunch.enabled'],
      [{ repos: 'work/sample-shop' }, 'agentLaunch.repos'],
      [{ repos: ['work/sample-shop'] }, 'agentLaunch.repos'],
      [{ repos: [3] }, 'agentLaunch.repos'],
      [{ claudePath: 'claude' }, 'agentLaunch.claudePath'],
      [{ permissionMode: 'bypassPermissions' }, 'agentLaunch.permissionMode'],
      [{ timeoutMinutes: 0 }, 'agentLaunch.timeoutMinutes'],
      [{ timeoutMinutes: 121 }, 'agentLaunch.timeoutMinutes'],
      [{ timeoutMinutes: 1.5 }, 'agentLaunch.timeoutMinutes'],
      [{ timeoutMinutes: '30' }, 'agentLaunch.timeoutMinutes'],
    ];
    for (const [value, field] of cases) {
      expect(with_(value)).toMatchObject({ ok: false, error: expect.stringContaining(`"${field}`) as unknown });
    }
  });

  it('a bad agentLaunch leaves the rest of the file valid (trust keeps working)', () => {
    const parsed = parseSettings(JSON.stringify({ v: 1, trustedRepos: ['/work/sample-shop'], agentLaunch: { permissionMode: 'bypassPermissions' } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(agentLaunchSettings(parsed.settings).ok).toBe(false);
  });
});
