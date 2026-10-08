// scripts/bench-spawn.mjs (DC-45): the spawn bench records, for each way of
// starting a daemon-like process, the median cost of spawning /usr/bin/true
// there. Only the `node` scenario runs here: the shim scenarios execute a
// freshly written script, whose cost on macOS depends on the machine's load.

import { describe, expect, it } from 'vitest';
import { formatTable, runBench, SCENARIOS, summarize } from '../../../scripts/bench-spawn.mjs';

describe('spawn bench', () => {
  it('spawn/bench-records-numbers', async () => {
    const record = await runBench({ runs: 3, scenarios: ['node'] });
    expect(record.platform).toBe(process.platform);
    expect(record.node).toBe(process.version);
    expect(record.runs).toBe(3);
    expect(record.loadavg).toHaveLength(3);
    expect(record.shimProvenance === null).toBe(process.platform !== 'darwin');
    expect(record.scenarios).toHaveLength(1);
    const [node] = record.scenarios;
    expect(node).toMatchObject({ name: 'node', launchedBy: 'node probe.mjs', runs: 3 });
    for (const value of [node?.medianMs, node?.minMs, node?.maxMs]) {
      expect(value).toBeTypeOf('number');
      expect(value).toBeGreaterThan(0);
    }
    expect(node?.minMs).toBeLessThanOrEqual(node?.medianMs ?? 0);
    expect(node?.medianMs).toBeLessThanOrEqual(node?.maxMs ?? 0);
    expect(formatTable(record)).toMatch(/^node\s+\d+\.\d\d\s+\d+\.\d\d\s+\d+\.\d\d\s+node probe\.mjs$/m);
  });

  it('spawn/bench-summarizes-samples', () => {
    expect(summarize('shim', [3, 1, 2000.126, 2])).toEqual({
      name: 'shim',
      launchedBy: 'the shim, executed directly',
      runs: 4,
      medianMs: 2.5,
      minMs: 1,
      maxMs: 2000.13,
    });
    expect(summarize('node', [4, 1, 9]).medianMs).toBe(4);
    expect(() => summarize('node', [])).toThrow('no samples');
  });

  it('spawn/bench-rejects-unknown-scenarios', async () => {
    expect(SCENARIOS).toContain('shim-open');
    await expect(runBench({ runs: 1, scenarios: ['nope'] })).rejects.toThrow('unknown scenario: nope');
  });
});
