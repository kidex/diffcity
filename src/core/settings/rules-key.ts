// The rules key (ADR-030, DC-121): everything a snapshot's rules depend on
// besides the content. Stored with each snapshot, so a daemon started after
// settings.json or a trusted diffcity.config.js changed, or after an upgrade
// that changed the rules engine, computes the affected snapshots again. A
// sha256, so the stored key carries no rule text or path.

import { createHash } from 'node:crypto';
import type { UserRuleSettings } from './settings.js';

/**
 * The version of the rules engine's output. Bump it with any change that gives
 * other rule output (findings, checks, their ids or texts) for the same input:
 * every stored snapshot is then computed again once, on the next collection.
 */
export const RULES_ENGINE_VERSION = 1;

/**
 * A rule list as the key sees it: absent (undefined) and `null` are told
 * apart, since an absent list gives no rules and `null` gives an error check.
 * JSON.stringify alone would write both as null in an array.
 */
function list(rules: UserRuleSettings, field: keyof UserRuleSettings): unknown {
  const value = rules[field];
  return value === undefined ? 'absent' : { value };
}

/**
 * The key of a repo's rules: the engine version, trust, the config's mtime
 * (only for a trusted repo, whose config runs; null when there is none) and
 * the user's rule lists. `engineVersion` is for tests.
 */
export function rulesKey(trusted: boolean, configStamp: number | null, rules: UserRuleSettings, engineVersion = RULES_ENGINE_VERSION): string {
  return createHash('sha256')
    .update(JSON.stringify([engineVersion, trusted, trusted ? configStamp : null, list(rules, 'settings'), list(rules, 'settingsRepo')]))
    .digest('hex');
}
