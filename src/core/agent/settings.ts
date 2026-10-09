// `agentLaunch` of the user settings file (ADR-029): whether "send review to
// the agent" may start Claude Code, for which repos, with which binary,
// permission mode and timeout. It is read from `<DIFFCITY_HOME>/settings.json`
// only, never from a repo's config. Like `tools`, a bad entry does not
// invalidate the file (trust and rules keep working); it turns the launch off
// and says why.

import { isAbsolute } from 'node:path';
import type { UserSettings } from '../settings/settings.js';

/**
 * The permission modes a launch may pass. Claude Code accepts more
 * (`auto`, `bypassPermissions`, `manual`, `dontAsk`); none of them can be
 * configured here, and `bypassPermissions` can never be produced.
 */
export const AGENT_PERMISSION_MODES = ['acceptEdits', 'plan'] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

export const AGENT_TIMEOUT_DEFAULT_MINUTES = 30;
/** The longest `timeoutMinutes` accepted; the claude tool profile's timeout is this. */
export const AGENT_TIMEOUT_MAX_MINUTES = 120;

export interface AgentLaunchSettings {
  enabled: boolean;
  /** Absolute repo paths as written; compared after realpath. */
  repos: string[];
  /** The claude binary; null to use `tools.claude` or the PATH. */
  claudePath: string | null;
  permissionMode: AgentPermissionMode | null;
  timeoutMinutes: number;
}

export type AgentLaunchParse = { ok: true; settings: AgentLaunchSettings } | { ok: false; error: string };

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as readonly string[]).includes(value);
}

export function defaultAgentLaunch(): AgentLaunchSettings {
  return { enabled: false, repos: [], claudePath: null, permissionMode: null, timeoutMinutes: AGENT_TIMEOUT_DEFAULT_MINUTES };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (error: string): AgentLaunchParse => ({ ok: false, error: `field "agentLaunch.${error}` });

/** `agentLaunch` of parsed settings: the defaults when absent (launch off), or why it is invalid. Pure. */
export function agentLaunchSettings(settings: UserSettings): AgentLaunchParse {
  const raw = settings['agentLaunch'];
  if (raw === undefined) return { ok: true, settings: defaultAgentLaunch() };
  if (!isObject(raw)) return { ok: false, error: 'field "agentLaunch" must be an object' };
  const result = defaultAgentLaunch();

  const { enabled, repos, claudePath, permissionMode, timeoutMinutes } = raw;
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return fail('enabled" must be true or false');
    result.enabled = enabled;
  }
  if (repos !== undefined) {
    const entries: unknown = repos;
    if (!Array.isArray(entries) || !entries.every((entry): entry is string => typeof entry === 'string' && isAbsolute(entry) && !entry.includes('\0'))) {
      return fail('repos" must be an array of absolute paths');
    }
    result.repos = [...entries];
  }
  if (claudePath !== undefined && claudePath !== null) {
    if (typeof claudePath !== 'string' || !isAbsolute(claudePath) || claudePath.includes('\0')) return fail('claudePath" must be an absolute path or null');
    result.claudePath = claudePath;
  }
  if (permissionMode !== undefined && permissionMode !== null) {
    if (!isAgentPermissionMode(permissionMode)) return fail(`permissionMode" must be null, ${AGENT_PERMISSION_MODES.map((mode) => `"${mode}"`).join(' or ')}`);
    result.permissionMode = permissionMode;
  }
  if (timeoutMinutes !== undefined) {
    if (typeof timeoutMinutes !== 'number' || !Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > AGENT_TIMEOUT_MAX_MINUTES) {
      return fail(`timeoutMinutes" must be an integer from 1 to ${String(AGENT_TIMEOUT_MAX_MINUTES)}`);
    }
    result.timeoutMinutes = timeoutMinutes;
  }
  return { ok: true, settings: result };
}
