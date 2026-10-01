// gh availability from `gh pr list` itself (ADR-020, SPEC.md section 3a C5,
// DC-49): the outcome is classified, and an unavailable gh is skipped for an
// hour: everywhere when it is not installed, per repo when it fails there.

import { describe, expect, it } from 'vitest';
import { fetchOpenPrs, GH_PR_LIST_ARGS } from '../../../src/core/changes/index.js';
import { createGhGate, GH_TIMEOUT_PAUSE_MS, GH_UNAVAILABLE_TTL_MS } from '../../../src/daemon/collector/gh.js';
import { fakeRunner } from '../../helpers/git-env.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');
const PR = { number: 4, title: 'Bread rack', headRefName: 'feature/rack', headRefOid: 'a'.repeat(40), baseRefName: 'main', isCrossRepository: false };

describe('fetchOpenPrs', () => {
  it('one `gh pr list` call, no probe: the PRs when it works', async () => {
    const gh = fakeRunner(() => JSON.stringify([PR]));
    expect(await fetchOpenPrs('/work/sample-shop', gh.runner)).toEqual({ ok: true, prs: [PR] });
    expect(gh.calls.map((call) => call.args)).toEqual([GH_PR_LIST_ARGS]);
  });

  it('classifies the failures: missing, failed (non-zero exit or unreadable) and timeout', async () => {
    const fails = (error: object) =>
      fakeRunner(() => {
        throw Object.assign(new Error('gh failed'), error);
      }).runner;
    expect(await fetchOpenPrs('/work/sample-shop', fails({ code: 'ENOENT' }))).toEqual({ ok: false, reason: 'missing' });
    expect(await fetchOpenPrs('/work/sample-shop', fails({ code: 4 }))).toEqual({ ok: false, reason: 'failed' });
    expect(await fetchOpenPrs('/work/sample-shop', fails({ killed: true, signal: 'SIGTERM' }))).toEqual({ ok: false, reason: 'timeout' });
    expect(await fetchOpenPrs('/work/sample-shop', fakeRunner(() => 'not json').runner)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('gh gate', () => {
  it('gh not installed: every repo skips gh for an hour', () => {
    let clock = START;
    const gate = createGhGate(() => new Date(clock));
    gate.record(1, { ok: false, reason: 'missing' });
    expect([gate.usable(1), gate.usable(2)]).toEqual([false, false]);
    clock += GH_UNAVAILABLE_TTL_MS;
    expect([gate.usable(1), gate.usable(2)]).toEqual([true, true]);
  });

  it('gh failing in one repo (no auth, no remote) skips only that repo for an hour', () => {
    let clock = START;
    const gate = createGhGate(() => new Date(clock));
    gate.record(1, { ok: false, reason: 'failed' });
    expect([gate.usable(1), gate.usable(2)]).toEqual([false, true]);
    clock += GH_UNAVAILABLE_TTL_MS - 1;
    expect(gate.usable(1)).toBe(false);
    clock += 1;
    expect(gate.usable(1)).toBe(true);
  });

  it('a timeout is unavailable for that collection only; a success clears the repo', () => {
    const gate = createGhGate(() => new Date(START));
    gate.record(1, { ok: false, reason: 'timeout' });
    expect(gate.usable(1)).toBe(true);
    gate.record(1, { ok: false, reason: 'failed' });
    gate.record(1, { ok: true, prs: [] });
    expect(gate.usable(1)).toBe(true);
  });

  it('a hung GitHub: 2 timeouts in a row pause gh in that repo for 5 minutes', () => {
    let clock = START;
    const gate = createGhGate(() => new Date(clock));
    const timeout = { ok: false, reason: 'timeout' } as const;
    gate.record(1, timeout);
    expect(gate.usable(1)).toBe(true);
    gate.record(1, timeout);
    expect([gate.usable(1), gate.usable(2)]).toEqual([false, true]);
    clock += GH_TIMEOUT_PAUSE_MS - 1;
    expect(gate.usable(1)).toBe(false);
    clock += 1;
    expect(gate.usable(1)).toBe(true);
    // The count starts over after the pause, and any answer resets it.
    gate.record(1, timeout);
    expect(gate.usable(1)).toBe(true);
    gate.record(1, { ok: true, prs: [] });
    gate.record(1, timeout);
    expect(gate.usable(1)).toBe(true);
  });
});
