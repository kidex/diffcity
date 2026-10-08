// The environment of an external tool (ADR-032): an allow-list taken from the
// daemon's environment, never the whole of it, plus the guards every tool gets.
// A tool such as gh runs `git` inside the collected repo without the flags
// every diffcity git call carries, so the ADR-024 guards go in through the
// environment and any git the tool starts inherits them.

import { configEnv } from '../git/guard.js';
import { STATIC_OVERRIDES } from '../git/exec.js';

/** Kept for every tool when the daemon has them. */
export const COMMON_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
];

/** Every `LC_*` locale variable is kept too. */
const LOCALE = /^LC_[A-Z_]+$/;

/**
 * Set for every tool, over anything kept: the static ADR-024 git overrides,
 * no git transport, no lazy fetch, no prompt or update notice, no colour, and
 * npm never running scripts or nagging.
 */
export function toolGuards(): Record<string, string> {
  return {
    ...configEnv(STATIC_OVERRIDES, {}),
    GIT_ALLOW_PROTOCOL: '',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
  };
}

/** The environment a tool runs with: the allowed variables of `base`, then the guards. */
export function toolEnv(profileEnv: readonly string[], base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const allowed = new Set([...COMMON_ENV, ...profileEnv]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (allowed.has(name) || LOCALE.test(name))) env[name] = value;
  }
  return { ...env, ...toolGuards() };
}
