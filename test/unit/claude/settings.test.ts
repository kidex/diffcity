// The Stop hook merge into a Claude Code settings.json (SPEC.md section 7.2,
// ADR-037): data-only JSON, one entry with `matcher: ""`, never twice, every
// other key and hook kept, an unparsable file refused.

import { describe, expect, it } from 'vitest';
import { addStopHook, hasStopHook, removeStopHook, stopHookEntry, type SettingsEdit } from '../../../src/core/claude/settings.js';

const HOOK = 'diffcity track --agent';

/** The written text of a changed edit, parsed. */
function written(edit: SettingsEdit): unknown {
  if (!edit.ok || !edit.changed) throw new Error(`expected a change, got ${JSON.stringify(edit)}`);
  return JSON.parse(edit.text);
}

const existing = {
  model: 'sample-model',
  permissions: { allow: ['Bash(npm run lint)'], deny: [] },
  env: { SAMPLE_FLAG: '1' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sample-guard.sh' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }],
  },
  statusLine: { type: 'command', command: 'sample-status' },
};

describe('setup: the Stop hook in settings.json', () => {
  it('setup/merge-adds-stop-hook: a missing or empty file gets exactly the SPEC 7.2 entry', () => {
    const expected = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK }] }] } };
    expect(written(addStopHook(null, HOOK))).toEqual(expected);
    expect(written(addStopHook('', HOOK))).toEqual(expected);
    expect(written(addStopHook('{}\n', HOOK))).toEqual(expected);
    expect(written(addStopHook('{ "hooks": {} }', HOOK))).toEqual(expected);
    expect(stopHookEntry(HOOK)).toEqual(expected.hooks.Stop[0]);
  });

  it('setup/merge-adds-stop-hook (formatting): two-space JSON with a final newline', () => {
    const edit = addStopHook(null, HOOK);
    expect(edit).toEqual({
      ok: true,
      changed: true,
      text: '{\n  "hooks": {\n    "Stop": [\n      {\n        "matcher": "",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "diffcity track --agent"\n          }\n        ]\n      }\n    ]\n  }\n}\n',
    });
  });

  it('setup/merge-is-idempotent: a second merge changes nothing, wherever the identical command sits', () => {
    const once = addStopHook(null, HOOK);
    if (!once.ok || !once.changed) throw new Error('first merge must change the file');
    expect(addStopHook(once.text, HOOK)).toEqual({ ok: true, changed: false });
    // The identical command inside another Stop entry, with another matcher, counts too.
    const elsewhere = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: HOOK }] }] } });
    expect(addStopHook(elsewhere, HOOK)).toEqual({ ok: true, changed: false });
    expect(hasStopHook(elsewhere, HOOK)).toBe(true);
    // A different command (another invocation) is not ours: the entry is added.
    const other = JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'npx diffcity track --agent' }] }] } });
    expect(addStopHook(other, HOOK)).toMatchObject({ ok: true, changed: true });
  });

  it('setup/keeps-existing-hooks-and-keys: every other key, event and Stop entry stays as it was, in order', () => {
    const merged = written(addStopHook(JSON.stringify(existing, null, 4), HOOK)) as typeof existing;
    expect(merged).toEqual({
      ...existing,
      hooks: { ...existing.hooks, Stop: [...existing.hooks.Stop, { matcher: '', hooks: [{ type: 'command', command: HOOK }] }] },
    });
    expect(Object.keys(merged)).toEqual(Object.keys(existing));
    expect(Object.keys(merged.hooks)).toEqual(['PreToolUse', 'Stop']);
  });

  it('setup/unparsable-settings-refused: not JSON, not an object, or hooks of the wrong type', () => {
    expect(addStopHook('{ "model": "sample", }', HOOK)).toMatchObject({ ok: false, reason: expect.stringMatching(/^is not valid JSON \(/) as unknown });
    expect(addStopHook('// a comment\n{}', HOOK)).toMatchObject({ ok: false });
    expect(addStopHook('[]', HOOK)).toEqual({ ok: false, reason: 'is not a JSON object' });
    expect(addStopHook('"text"', HOOK)).toEqual({ ok: false, reason: 'is not a JSON object' });
    expect(addStopHook('{ "hooks": [] }', HOOK)).toEqual({ ok: false, reason: '"hooks" is not an object' });
    expect(addStopHook('{ "hooks": { "Stop": {} } }', HOOK)).toEqual({ ok: false, reason: '"hooks.Stop" is not an array' });
    expect(removeStopHook('{ "model": ', [HOOK])).toMatchObject({ ok: false });
  });
});

describe('setup: removing the Stop hook', () => {
  it('removes only hooks with the identical command, and the containers it emptied', () => {
    const merged = addStopHook(JSON.stringify(existing), HOOK);
    if (!merged.ok || !merged.changed) throw new Error('merge must change the file');
    expect(written(removeStopHook(merged.text, [HOOK]))).toEqual(existing);

    const alone = addStopHook(JSON.stringify({ model: 'sample-model' }), HOOK);
    if (!alone.ok || !alone.changed) throw new Error('merge must change the file');
    expect(written(removeStopHook(alone.text, [HOOK]))).toEqual({ model: 'sample-model' });
  });

  it('keeps a hook that shares a Stop entry with ours, and the other keys of that entry', () => {
    const shared = JSON.stringify({ hooks: { Stop: [{ matcher: '', note: 'kept', hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: HOOK }] }] } });
    expect(written(removeStopHook(shared, [HOOK]))).toEqual({ hooks: { Stop: [{ matcher: '', note: 'kept', hooks: [{ type: 'command', command: 'say done' }] }] } });
  });

  it('changes nothing without our hook, without a file, or with only a similar command', () => {
    expect(removeStopHook(null, [HOOK])).toEqual({ ok: true, changed: false });
    expect(removeStopHook(JSON.stringify(existing), [HOOK])).toEqual({ ok: true, changed: false });
    const similar = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `${HOOK} --verbose` }] }] } });
    expect(removeStopHook(similar, [HOOK])).toEqual({ ok: true, changed: false });
  });

  it('removes every listed command (the current invocation and the recorded one)', () => {
    const both = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK }] }, { hooks: [{ type: 'command', command: '"/opt/sample/node" "/opt/sample/dist/cli/index.js" track --agent' }] }] } });
    expect(written(removeStopHook(both, [HOOK, '"/opt/sample/node" "/opt/sample/dist/cli/index.js" track --agent']))).toEqual({});
  });
});
