// ui/repo-notes (DC-61): the copy of the daemon's repo notes. Known notes get
// user copy and, when there is one, the command that resolves them; any other
// code is shown with the daemon's text.

import { describe, expect, it } from 'vitest';
import type { RepoNote } from '../../../src/core/model/types.js';
import { noteCopy, noteSummary, shellArg } from '../../../src/ui/shared/notes.js';

/** What the daemon sends for an untrusted config; the UI words it by `code`. */
const CONFIG_NOT_TRUSTED: RepoNote = { code: 'config-not-trusted', text: 'config not loaded: repo not trusted (run diffcity trust)' };
const UNKNOWN: RepoNote = { code: 'watcher-limited', text: 'watcher limited to git events' };

describe('repo notes', () => {
  it('explains the untrusted config and gives the trust command for the repo path', () => {
    expect(noteCopy(CONFIG_NOT_TRUSTED, '/work/sample-shop')).toEqual({
      text: 'This repo has a diffcity.config.js that isn’t loaded because the repo isn’t trusted. Defaults are used for the base and tier 1.',
      command: 'diffcity trust /work/sample-shop',
    });
  });

  it('shows an unknown note as it is, without a command', () => {
    expect(noteCopy(UNKNOWN, '/work/sample-shop')).toEqual({ text: 'watcher limited to git events', command: null });
    expect(noteSummary(UNKNOWN, '/work/sample-shop')).toBe('watcher limited to git events');
  });

  it('words a known code by the code, not by the daemon text', () => {
    expect(noteCopy({ ...CONFIG_NOT_TRUSTED, text: 'worded otherwise' }, '/work/sample-shop').command).toBe('diffcity trust /work/sample-shop');
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
