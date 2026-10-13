// The rules key (ADR-030, DC-121): a stable hash of trust, the trusted config's
// mtime and the user's rules.

import { describe, expect, it } from 'vitest';
import { RULES_ENGINE_VERSION, rulesKey } from '../../../src/core/settings/index.js';

const SIZE = { settings: [{ id: 'size', kind: 'file-size', maxLines: 5 }] };

describe('rulesKey', () => {
  it('settings/rules-key: a hex sha256 that moves with trust, the trusted config mtime and the rules, and nothing else', () => {
    const key = rulesKey(true, 1000, SIZE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(rulesKey(true, 1000, { settings: [{ id: 'size', kind: 'file-size', maxLines: 5 }] })).toBe(key);
    expect(rulesKey(false, 1000, SIZE)).not.toBe(key);
    expect(rulesKey(true, 2000, SIZE)).not.toBe(key);
    expect(rulesKey(true, 1000, {})).not.toBe(key);
    expect(rulesKey(true, 1000, { settingsRepo: SIZE.settings })).not.toBe(key);
    // An untrusted repo's config never runs, so its mtime does not matter.
    expect(rulesKey(false, 1000, SIZE)).toBe(rulesKey(false, 2000, SIZE));
    expect(rulesKey(false, null, {})).toBe(rulesKey(false, 5, {}));
  });

  it('settings/rules-key-null-list: a list set to null is not an absent one (null gives an error check)', () => {
    expect(rulesKey(true, 1, {})).not.toBe(rulesKey(true, 1, { settingsRepo: null }));
    expect(rulesKey(true, 1, {})).not.toBe(rulesKey(true, 1, { settings: null }));
    expect(rulesKey(true, 1, { settings: null })).not.toBe(rulesKey(true, 1, { settingsRepo: null }));
  });

  it('settings/rules-key-engine-version: another rules engine version gives another key', () => {
    expect(rulesKey(true, 1, SIZE)).toBe(rulesKey(true, 1, SIZE, RULES_ENGINE_VERSION));
    expect(rulesKey(true, 1, SIZE, RULES_ENGINE_VERSION + 1)).not.toBe(rulesKey(true, 1, SIZE));
  });
});
