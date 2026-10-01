// The gh availability probe (ADR-020, SPEC.md section 3a C5): installed and
// authenticated, cached for an hour per daemon.

import { describe, expect, it } from 'vitest';
import { createGhProbe, GH_PROBE_TTL_MS } from '../../../src/daemon/collector/gh.js';
import { fakeRunner } from '../../helpers/git-env.js';

const START = Date.parse('2026-02-01T00:00:00.000Z');

describe('gh probe', () => {
  it('available when `gh --version` and `gh auth status` succeed; cached for an hour', async () => {
    const gh = fakeRunner(() => '');
    let clock = START;
    const probe = createGhProbe(gh.runner, () => new Date(clock));
    expect(await probe.available('/work/sample-shop')).toBe(true);
    expect(gh.calls.map((call) => call.args.join(' ')).sort()).toEqual(['--version', 'auth status']);
    clock += GH_PROBE_TTL_MS - 1;
    expect(await probe.available('/work/sample-shop')).toBe(true);
    expect(gh.calls).toHaveLength(2);
    clock += 1;
    await probe.available('/work/sample-shop');
    expect(gh.calls).toHaveLength(4);
  });

  it('not available when auth status fails', async () => {
    const gh = fakeRunner((call) => {
      if (call.args[0] === 'auth') throw new Error('not logged in');
      return '';
    });
    expect(await createGhProbe(gh.runner, () => new Date(START)).available('/work/sample-shop')).toBe(false);
  });

  it('not available when gh is not installed', async () => {
    const gh = fakeRunner(() => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    });
    expect(await createGhProbe(gh.runner, () => new Date(START)).available('/work/sample-shop')).toBe(false);
  });
});
