// The Stop hook entry in a Claude Code `settings.json` (SPEC.md section 7.2,
// ADR-037), as data-only JSON edits. Adding puts
// `{ "matcher": "", "hooks": [{ "type": "command", "command": <hook> }] }` at
// the end of `hooks.Stop` unless a hook with the identical command is already
// there. Removing takes out every hook with the identical command, then the
// Stop entries it left empty, then `Stop` and `hooks` when they end up empty
// (an empty `Stop` or `hooks` means the same to Claude Code as none). Every
// other key and hook is kept as parsed. A file that is not JSON, or whose
// `hooks` / `hooks.Stop` has another type, is refused and never rewritten.

export type SettingsEdit =
  | { ok: true; changed: false }
  | { ok: true; changed: true; text: string }
  | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Stop hook entry diffcity adds. */
export function stopHookEntry(command: string): JsonObject {
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
  if (isObject(value.hooks) && value.hooks.Stop !== undefined && !Array.isArray(value.hooks.Stop)) {
    return { ok: false, reason: '"hooks.Stop" is not an array' };
  }
  return { ok: true, settings: value };
}

const serialize = (settings: JsonObject): string => `${JSON.stringify(settings, null, 2)}\n`;

function isHookWith(hook: unknown, commands: ReadonlySet<string>): boolean {
  return isObject(hook) && hook.type === 'command' && typeof hook.command === 'string' && commands.has(hook.command);
}

/** The hooks of a Stop entry, when it has a list of them. */
const entryHooks = (entry: unknown): unknown[] | null => (isObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : null);

/** True when `text` holds a Stop hook with the identical `command`. */
export function hasStopHook(text: string | null, command: string): boolean {
  const parsed = parse(text);
  if (!parsed.ok) return false;
  const hooks = parsed.settings.hooks;
  const stop = isObject(hooks) && Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const wanted = new Set([command]);
  return stop.some((entry) => entryHooks(entry)?.some((hook) => isHookWith(hook, wanted)) === true);
}

/** Adds the Stop hook for `command` to `text` (null for a missing file). */
export function addStopHook(text: string | null, command: string): SettingsEdit {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  if (hasStopHook(text, command)) return { ok: true, changed: false };
  const { settings } = parsed;
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const stop: unknown[] = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
  hooks.Stop = [...stop, stopHookEntry(command)];
  settings.hooks = hooks;
  return { ok: true, changed: true, text: serialize(settings) };
}

/** Removes every Stop hook whose command is one of `commands`. */
export function removeStopHook(text: string | null, commands: readonly string[]): SettingsEdit {
  if (text === null) return { ok: true, changed: false };
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const { settings } = parsed;
  const hooks = settings.hooks;
  if (!isObject(hooks) || !Array.isArray(hooks.Stop)) return { ok: true, changed: false };
  const wanted = new Set(commands);
  let removed = false;
  const stop: unknown[] = [];
  for (const entry of hooks.Stop) {
    const list = entryHooks(entry);
    if (list === null || !isObject(entry)) {
      stop.push(entry);
      continue;
    }
    const kept = list.filter((hook) => !isHookWith(hook, wanted));
    if (kept.length === list.length) {
      stop.push(entry);
      continue;
    }
    removed = true;
    if (kept.length > 0) stop.push({ ...entry, hooks: kept });
  }
  if (!removed) return { ok: true, changed: false };
  if (stop.length > 0) hooks.Stop = stop;
  else Reflect.deleteProperty(hooks, 'Stop');
  if (Object.keys(hooks).length === 0) Reflect.deleteProperty(settings, 'hooks');
  return { ok: true, changed: true, text: serialize(settings) };
}
