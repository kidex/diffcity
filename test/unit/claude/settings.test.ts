// The hook merge into a Claude Code settings.json (SPEC.md section 7.2,
// ADR-037, DC-128): data-only JSON, one entry with `matcher: ""` under
// `hooks.Stop` and one under `hooks.SessionEnd`, each never twice, every other
// key and hook kept, an unparsable file refused.

import { describe, expect, it } from 'vitest';
import { DIFFCITY_HOOK_EVENTS, addHooks, hasHook, hookEntry, removeHooks, type SettingsEdit } from '../../../src/core/claude/settings.js';

const HOOK = 'diffcity track --agent';
const ENTRY = { matcher: '', hooks: [{ type: 'command', command: HOOK }] };

/** The written text of a changed edit, parsed. */
function written(edit: SettingsEdit): unknown {
  if (!edit.ok || !edit.changed) throw new Error(`expected a change, got ${JSON.stringify(edit)}`);
  return JSON.parse(edit.text);
}

/** The events a changed edit touched. */
function events(edit: SettingsEdit): readonly string[] {
  if (!edit.ok || !edit.changed) throw new Error(`expected a change, got ${JSON.stringify(edit)}`);
  return edit.events;
}

const existing = {
  model: 'sample-model',
  permissions: { allow: ['Bash(npm run lint)'], deny: [] },
  env: { SAMPLE_FLAG: '1' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sample-guard.sh' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }],
    SessionEnd: [{ matcher: 'logout', hooks: [{ type: 'command', command: 'sample-bye' }] }],
  },
  statusLine: { type: 'command', command: 'sample-status' },
};

describe('setup: the Stop and SessionEnd hooks in settings.json', () => {
  it('the events are Stop and SessionEnd, in that order', () => {
    expect(DIFFCITY_HOOK_EVENTS).toEqual(['Stop', 'SessionEnd']);
  });

  it('setup/merge-adds-stop-hook: a missing or empty file gets the SPEC 7.2 entry under Stop and SessionEnd', () => {
    const expected = { hooks: { Stop: [ENTRY], SessionEnd: [ENTRY] } };
    expect(written(addHooks(null, HOOK))).toEqual(expected);
    expect(written(addHooks('', HOOK))).toEqual(expected);
    expect(written(addHooks('{}\n', HOOK))).toEqual(expected);
    expect(written(addHooks('{ "hooks": {} }', HOOK))).toEqual(expected);
    expect(events(addHooks(null, HOOK))).toEqual(['Stop', 'SessionEnd']);
    expect(hookEntry(HOOK)).toEqual(ENTRY);
  });

  it('setup/merge-adds-session-end-hook: an install with only the Stop hook gets the SessionEnd hook alone', () => {
    const stopOnly = JSON.stringify({ hooks: { Stop: [ENTRY] } });
    const edit = addHooks(stopOnly, HOOK);
    expect(written(edit)).toEqual({ hooks: { Stop: [ENTRY], SessionEnd: [ENTRY] } });
    expect(events(edit)).toEqual(['SessionEnd']);
  });

  it('setup/merge-adds-stop-hook (formatting): two-space JSON with a final newline', () => {
    const edit = addHooks(null, HOOK);
    const entry = '[\n      {\n        "matcher": "",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "diffcity track --agent"\n          }\n        ]\n      }\n    ]';
    expect(edit).toEqual({
      ok: true,
      changed: true,
      events: ['Stop', 'SessionEnd'],
      text: `{\n  "hooks": {\n    "Stop": ${entry},\n    "SessionEnd": ${entry}\n  }\n}\n`,
    });
  });

  it('setup/merge-is-idempotent: a second merge changes nothing, wherever the identical command sits', () => {
    const once = addHooks(null, HOOK);
    if (!once.ok || !once.changed) throw new Error('first merge must change the file');
    expect(addHooks(once.text, HOOK)).toEqual({ ok: true, changed: false });
    // The identical command inside another entry, with another matcher, counts too.
    const elsewhere = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: HOOK }] }],
        SessionEnd: [{ matcher: 'clear', hooks: [{ type: 'command', command: HOOK }] }],
      },
    });
    expect(addHooks(elsewhere, HOOK)).toEqual({ ok: true, changed: false });
    expect(hasHook(elsewhere, 'Stop', HOOK)).toBe(true);
    expect(hasHook(elsewhere, 'SessionEnd', HOOK)).toBe(true);
    expect(hasHook(JSON.stringify({ hooks: { Stop: [ENTRY] } }), 'SessionEnd', HOOK)).toBe(false);
    // A different command (another invocation) is not ours: the entries are added.
    const other = JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'npx diffcity track --agent' }] }] } });
    expect(addHooks(other, HOOK)).toMatchObject({ ok: true, changed: true, events: ['Stop', 'SessionEnd'] });
  });

  it('setup/keeps-existing-hooks-and-keys: every other key, event and entry stays as it was, in order', () => {
    const merged = written(addHooks(JSON.stringify(existing, null, 4), HOOK)) as typeof existing;
    expect(merged).toEqual({
      ...existing,
      hooks: { ...existing.hooks, Stop: [...existing.hooks.Stop, ENTRY], SessionEnd: [...existing.hooks.SessionEnd, ENTRY] },
    });
    expect(Object.keys(merged)).toEqual(Object.keys(existing));
    expect(Object.keys(merged.hooks)).toEqual(['PreToolUse', 'Stop', 'SessionEnd']);
    // Without a SessionEnd of its own, the new one goes after the other events.
    const withoutEnd = { PreToolUse: existing.hooks.PreToolUse, Stop: existing.hooks.Stop };
    const appended = written(addHooks(JSON.stringify({ ...existing, hooks: withoutEnd }), HOOK)) as typeof existing;
    expect(Object.keys(appended.hooks)).toEqual(['PreToolUse', 'Stop', 'SessionEnd']);
  });

  it('setup/unparsable-settings-refused: not JSON, not an object, or hooks of the wrong type', () => {
    expect(addHooks('{ "model": "sample", }', HOOK)).toMatchObject({ ok: false, reason: expect.stringMatching(/^is not valid JSON \(/) as unknown });
    expect(addHooks('// a comment\n{}', HOOK)).toMatchObject({ ok: false });
    expect(addHooks('[]', HOOK)).toEqual({ ok: false, reason: 'is not a JSON object' });
    expect(addHooks('"text"', HOOK)).toEqual({ ok: false, reason: 'is not a JSON object' });
    expect(addHooks('{ "hooks": [] }', HOOK)).toEqual({ ok: false, reason: '"hooks" is not an object' });
    expect(addHooks('{ "hooks": { "Stop": {} } }', HOOK)).toEqual({ ok: false, reason: '"hooks.Stop" is not an array' });
    expect(addHooks('{ "hooks": { "SessionEnd": "x" } }', HOOK)).toEqual({ ok: false, reason: '"hooks.SessionEnd" is not an array' });
    expect(removeHooks('{ "hooks": { "SessionEnd": {} } }', [HOOK])).toEqual({ ok: false, reason: '"hooks.SessionEnd" is not an array' });
    expect(removeHooks('{ "model": ', [HOOK])).toMatchObject({ ok: false });
  });
});

describe('setup: removing the hooks', () => {
  it('removes only hooks with the identical command, and the containers it emptied', () => {
    const merged = addHooks(JSON.stringify(existing), HOOK);
    if (!merged.ok || !merged.changed) throw new Error('merge must change the file');
    const removed = removeHooks(merged.text, [HOOK]);
    expect(written(removed)).toEqual(existing);
    expect(events(removed)).toEqual(['Stop', 'SessionEnd']);

    const alone = addHooks(JSON.stringify({ model: 'sample-model' }), HOOK);
    if (!alone.ok || !alone.changed) throw new Error('merge must change the file');
    expect(written(removeHooks(alone.text, [HOOK]))).toEqual({ model: 'sample-model' });
  });

  it('setup/remove-session-end-only: an install from before DC-128 (Stop alone) and a SessionEnd alone are both removed', () => {
    const stopOnly = removeHooks(JSON.stringify({ hooks: { Stop: [ENTRY] } }), [HOOK]);
    expect(written(stopOnly)).toEqual({});
    expect(events(stopOnly)).toEqual(['Stop']);
    const endOnly = removeHooks(JSON.stringify({ hooks: { SessionEnd: [ENTRY], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }), [HOOK]);
    expect(written(endOnly)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    expect(events(endOnly)).toEqual(['SessionEnd']);
  });

  it('keeps a hook that shares an entry with ours, and the other keys of that entry', () => {
    const shared = JSON.stringify({
      hooks: {
        Stop: [{ matcher: '', note: 'kept', hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: HOOK }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: HOOK }, { type: 'command', command: 'sample-bye' }] }],
      },
    });
    expect(written(removeHooks(shared, [HOOK]))).toEqual({
      hooks: {
        Stop: [{ matcher: '', note: 'kept', hooks: [{ type: 'command', command: 'say done' }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: 'sample-bye' }] }],
      },
    });
  });

  it('changes nothing without our hook, without a file, or with only a similar command', () => {
    expect(removeHooks(null, [HOOK])).toEqual({ ok: true, changed: false });
    expect(removeHooks(JSON.stringify(existing), [HOOK])).toEqual({ ok: true, changed: false });
    const similar = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${HOOK} --verbose` }] }], SessionEnd: [{ hooks: [{ type: 'command', command: `npx ${HOOK}` }] }] } });
    expect(removeHooks(similar, [HOOK])).toEqual({ ok: true, changed: false });
    // Our command under another event is not ours to remove.
    const elsewhere = JSON.stringify({ hooks: { SubagentStop: [ENTRY] } });
    expect(removeHooks(elsewhere, [HOOK])).toEqual({ ok: true, changed: false });
  });

  it('removes every listed command (the current invocation and the recorded one)', () => {
    const old = '"/opt/sample/node" "/opt/sample/dist/cli/index.js" track --agent';
    const both = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: HOOK }] }, { hooks: [{ type: 'command', command: old }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: old }] }],
      },
    });
    expect(written(removeHooks(both, [HOOK, old]))).toEqual({});
  });
});
