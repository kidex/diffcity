// notes/ui-code-matches-daemon (DC-67): the code the daemon sends for an
// untrusted repo is the code the UI words, so the user sees the trust copy and
// command rather than the plain-text fallback.

import { describe, expect, it } from 'vitest';
import { CONFIG_NOT_TRUSTED_CODE, CONFIG_NOT_TRUSTED_NOTE } from '../../../src/core/settings/settings.js';
import { noteCopy, noteSummary } from '../../../src/ui/shared/notes.js';

describe('notes/ui-code-matches-daemon', () => {
  const repoPath = '/work/sample-shop';

  it('the daemon note carries the exported code', () => {
    expect(CONFIG_NOT_TRUSTED_NOTE.code).toBe(CONFIG_NOT_TRUSTED_CODE);
  });

  it('the UI words the daemon note as "not trusted" with the trust command, not the fallback', () => {
    const copy = noteCopy(CONFIG_NOT_TRUSTED_NOTE, repoPath);
    expect(copy.command).toBe(`diffcity trust ${repoPath}`);
    expect(copy.text).toMatch(/isn’t trusted/);
    expect(copy.text).not.toBe(CONFIG_NOT_TRUSTED_NOTE.text);
    expect(noteSummary(CONFIG_NOT_TRUSTED_NOTE, repoPath)).toContain('Run: diffcity trust');
  });

  it('an unknown code falls back to the daemon text without a command', () => {
    const copy = noteCopy({ code: 'some-future-code', text: 'Plain daemon text.' }, repoPath);
    expect(copy).toEqual({ text: 'Plain daemon text.', command: null });
  });
});
