// The rules key (ADR-030, DC-121): everything a snapshot's rules depend on
// besides the content. Stored with each snapshot, so a daemon started after
// settings.json or a trusted diffcity.config.js changed computes the affected
// snapshots again. A sha256, so the stored key carries no rule text or path.

import { createHash } from 'node:crypto';
import type { UserRuleSettings } from './settings.js';

/**
 * The key of a repo's rules: trust, the config's mtime (only for a trusted
 * repo, whose config runs; null when there is none) and the user's rule lists.
 */
export function rulesKey(trusted: boolean, configStamp: number | null, rules: UserRuleSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([trusted, trusted ? configStamp : null, rules.settings ?? null, rules.settingsRepo ?? null]))
    .digest('hex');
}
