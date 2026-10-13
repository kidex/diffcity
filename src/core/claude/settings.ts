// diffcity's hook entries in a Claude Code `settings.json` (SPEC.md section
// 7.2, ADR-037, DC-128), as data-only JSON edits. The same entry
// `{ "matcher": "", "hooks": [{ "type": "command", "command": <hook> }] }` goes
// under `hooks.Stop` (a task finished) and `hooks.SessionEnd` (the session
// ended, so the daemon reads it as no longer active). Adding puts it at the
// end of each event's list unless a hook with the identical command is
// already there. Removing takes out every hook with the identical command
// under those two events, then the entries it left empty, then the event and
// `hooks` when they end up empty (an empty list or `hooks` means the same to
// Claude Code as none). Every other key, event and hook is kept as parsed. A
// file that is not JSON, or whose `hooks` / `hooks.Stop` / `hooks.SessionEnd`
// has another type, is refused and never rewritten.

/** The events diffcity hooks, in the order they are added. */
export const DIFFCITY_HOOK_EVENTS = ['Stop', 'SessionEnd'] as const;

export type DiffcityHookEvent = (typeof DIFFCITY_HOOK_EVENTS)[number];

export type SettingsEdit =
  | { ok: true; changed: false }
  /** `events`: the events whose hooks were added or removed, in DIFFCITY_HOOK_EVENTS order. */
  | { ok: true; changed: true; text: string; events: DiffcityHookEvent[] }
  | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The hook entry diffcity adds under each event. */
export function hookEntry(command: string): JsonObject {
  return { matcher: '', hooks: [{ type: 'command', command }] };
}

function parse(text: string | null): { ok: true; settings: JsonObject } | { ok: false; reason: string } {
  // A missing or blank file holds no settings yet.
  if (text === null || text.trim() === '') return { ok: true, settings: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isObject(value)) return { ok: false, reason: 'is not a JSON object' };
  if (value.hooks !== undefined && !isObject(value.hooks)) return { ok: false, reason: '"hooks" is not an object' };
  if (isObject(value.hooks)) {
    for (const event of DIFFCITY_HOOK_EVENTS) {
      if (value.hooks[event] !== undefined && !Array.isArray(value.hooks[event])) return { ok: false, reason: `"hooks.${event}" is not an array` };
    }
  }
  return { ok: true, settings: value };
}

const serialize = (settings: JsonObject): string => `${JSON.stringify(settings, null, 2)}\n`;

function isHookWith(hook: unknown, commands: ReadonlySet<string>): boolean {
  return isObject(hook) && hook.type === 'command' && typeof hook.command === 'string' && commands.has(hook.command);
}

/** The hooks of an entry, when it has a list of them. */
const entryHooks = (entry: unknown): unknown[] | null => (isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : null);

/** The entries of `event`; parse() has checked the type. */
const entriesOf = (hooks: unknown, event: DiffcityHookEvent): unknown[] => (isObject(hooks) && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []);

function holds(settings: JsonObject, event: DiffcityHookEvent, command: string): boolean {
  const wanted = new Set([command]);
  return entriesOf(settings.hooks, event).some((entry) => entryHooks(entry)?.some((hook) => isHookWith(hook, wanted)) === true);
}

/** True when `text` holds a hook of `event` with the identical `command`. */
export function hasHook(text: string | null, event: DiffcityHookEvent, command: string): boolean {
  const parsed = parse(text);
  return parsed.ok && holds(parsed.settings, event, command);
}

/** Adds the hook for `command` under every event that lacks it, in `text` (null for a missing file). */
export function addHooks(text: string | null, command: string): SettingsEdit {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { settings } = parsed;
  const missing = DIFFCITY_HOOK_EVENTS.filter((event) => !holds(settings, event, command));
  if (missing.length === 0) return { ok: true, changed: false };
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  for (const event of missing) hooks[event] = [...entriesOf(hooks, event), hookEntry(command)];
  settings.hooks = hooks;
  return { ok: true, changed: true, text: serialize(settings), events: missing };
}

/** Removes every hook of diffcity's events whose command is one of `commands`. */
export function removeHooks(text: string | null, commands: readonly string[]): SettingsEdit {
  if (text === null) return { ok: true, changed: false };
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { settings } = parsed;
  const hooks = settings.hooks;
  if (!isObject(hooks)) return { ok: true, changed: false };
  const wanted = new Set(commands);
  const events: DiffcityHookEvent[] = [];
  for (const event of DIFFCITY_HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    let removed = false;
    const kept: unknown[] = [];
    for (const entry of hooks[event] as unknown[]) {
      const list = entryHooks(entry);
      if (list === null || !isObject(entry)) {
        kept.push(entry);
        continue;
      }
      const left = list.filter((hook) => !isHookWith(hook, wanted));
      if (left.length === list.length) {
        kept.push(entry);
        continue;
      }
      removed = true;
      if (left.length > 0) kept.push({ ...entry, hooks: left });
    }
    if (!removed) continue;
    events.push(event);
    if (kept.length > 0) hooks[event] = kept;
    else Reflect.deleteProperty(hooks, event);
  }
  if (events.length === 0) return { ok: true, changed: false };
  if (Object.keys(hooks).length === 0) Reflect.deleteProperty(settings, 'hooks');
  return { ok: true, changed: true, text: serialize(settings), events };
}
