// ui/repo-notes (DC-61): the copy of the daemon's repo notes. Known notes get
// user copy and, when there is one, the command that resolves them; any other
// note is shown as the daemon wrote it.

import { describe, expect, it } from 'vitest';
import { CONFIG_NOT_TRUSTED, noteCopy, noteSummary, shellArg } from '../../../src/ui/shared/notes.js';

describe('repo notes', () => {
  it('explains the untrusted config and gives the trust command for the repo path', () => {
    expect(noteCopy(CONFIG_NOT_TRUSTED, '/work/sample-shop')).toEqual({
      text: 'This repo has a diffcity.config.js that isn’t loaded because the repo isn’t trusted. Defaults are used for the base and tier 1.',
      command: 'diffcity trust /work/sample-shop',
    });
  });

  it('shows an unknown note as it is, without a command', () => {
    expect(noteCopy('watcher limited to git events', '/work/sample-shop')).toEqual({ text: 'watcher limited to git events', command: null });
    expect(noteSummary('watcher limited to git events', '/work/sample-shop')).toBe('watcher limited to git events');
  });

  it('summarises a known note with its command', () => {
    expect(noteSummary(CONFIG_NOT_TRUSTED, '/work/sample-shop')).toMatch(/isn’t trusted\. .* Run: diffcity trust \/work\/sample-shop$/);
  });

  it('quotes a path the shell would split or expand', () => {
    expect(shellArg('/work/sample-shop')).toBe('/work/sample-shop');
    expect(shellArg('/work/sample shop')).toBe(`'/work/sample shop'`);
    expect(shellArg(`/work/it's $HOME`)).toBe(`'/work/it'\\''s $HOME'`);
  });
});
