// Merging the rule lists (ADR-030): user `rules`, then the user's per-repo
// `rules`, then the repo config's `rules` (only when the repo is trusted; the
// caller passes undefined otherwise). A later entry with the same id replaces
// the earlier one, except that a repo config can never introduce or override a
// `pipeline` or `cve` rule: such an entry is a config error. Pure.

import { ORIGIN_LABEL, RULE_ID_PATTERN, validateRules, type RuleConfig, type RuleKind, type RuleOrigin } from './config.js';

/** The raw `rules` values, as read; validated here. */
export interface RuleSources {
  /** `rules` of settings.json. */
  settings?: unknown;
  /** `repos.<repo root>.rules` of settings.json. */
  settingsRepo?: unknown;
  /** `rules` of the repo's diffcity.config.js; leave it out for an untrusted repo. */
  repoConfig?: unknown;
}

/** One rule after merging: ready to run, or a config error. */
export type MergedRule =
  | { ok: true; rule: RuleConfig; origin: RuleOrigin }
  | { ok: false; ruleId: string; kind: RuleKind | null; origin: RuleOrigin; reason: string };

/** `kind` of the config error check of a rule whose kind is unknown: file-size, the one kind with no user-only or network part. */
export const UNKNOWN_KIND_FALLBACK: RuleKind = 'file-size';

const USER_ONLY: ReadonlySet<RuleKind> = new Set<RuleKind>(['pipeline', 'cve']);

function configError(ruleId: string, kind: RuleKind | null, origin: RuleOrigin, message: string): MergedRule {
  return { ok: false, ruleId, kind, origin, reason: `config-error: ${ORIGIN_LABEL[origin]}: ${message}` };
}

function kindOf(entry: MergedRule): RuleKind | null {
  return entry.ok ? entry.rule.kind : entry.kind;
}

function idOf(entry: MergedRule): string {
  return entry.ok ? entry.rule.id : entry.ruleId;
}

/** The entries of one origin, with an id used twice in the same list turned into one error. */
function entriesOf(origin: RuleOrigin, value: unknown): MergedRule[] {
  const byId = new Map<string, MergedRule>();
  const duplicated = new Set<string>();
  for (const validated of validateRules(value)) {
    // An entry without a valid id is named by its place, qualified by its origin so two lists never collide.
    const errorId = (ruleId: string): string => (RULE_ID_PATTERN.test(ruleId) ? ruleId : `${origin}:${ruleId}`);
    const entry: MergedRule = validated.ok
      ? { ok: true, rule: validated.rule, origin }
      : configError(errorId(validated.error.ruleId), validated.error.kind, origin, validated.error.message);
    const id = idOf(entry);
    if (byId.has(id)) duplicated.add(id);
    else byId.set(id, entry);
  }
  return [...byId.values()].map((entry) => {
    const id = idOf(entry);
    return duplicated.has(id) ? configError(id, kindOf(entry), origin, `rule "${id}" is defined more than once`) : entry;
  });
}

/**
 * The effective rules, sorted by id (code unit order) so the checks of a
 * Report do not depend on how the lists were written. Ids are unique.
 */
export function mergeRules(sources: RuleSources): MergedRule[] {
  const merged = new Map<string, MergedRule>();
  for (const entry of [...entriesOf('settings', sources.settings), ...entriesOf('settings-repo', sources.settingsRepo)]) {
    merged.set(idOf(entry), entry);
  }
  for (const entry of entriesOf('repo-config', sources.repoConfig)) {
    const id = idOf(entry);
    const kind = kindOf(entry);
    const earlier = merged.get(id);
    const earlierKind = earlier === undefined ? null : kindOf(earlier);
    if (kind !== null && USER_ONLY.has(kind)) {
      merged.set(id, configError(id, kind, 'repo-config', `rule "${id}": kind "${kind}" is allowed in the user settings only`));
    } else if (earlierKind !== null && USER_ONLY.has(earlierKind)) {
      merged.set(id, configError(id, earlierKind, 'repo-config', `rule "${id}" cannot override the user's ${earlierKind} rule`));
    } else {
      merged.set(id, entry);
    }
  }
  return [...merged.values()].sort((a, b) => {
    const x = idOf(a);
    const y = idOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
