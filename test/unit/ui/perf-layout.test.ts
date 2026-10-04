// perf/layout-2000-files-under-50ms (ADR-026, DC-90): the pure layout of the
// `large` city (2,000 files, about 20,000 floors) takes less than 50 ms. The
// median of several runs is asserted, so one slow run on a busy machine does
// not fail it; the first run (the JIT warming up) is not counted.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Report } from '../../../src/core/report/types.js';
import { buildCity } from '../../../src/ui/screens/change/model/city.js';
import { levelFor, median, medianFps, PROBE_MS, QUALITY_LEVELS, QualityProbe, WARMUP_FRAMES } from '../../../src/ui/screens/change/scene/quality.js';

let large: Report;

beforeAll(() => {
  const out = join(mkdtempSync(join(tmpdir(), 'diffcity-large-')), 'large.json');
  execFileSync(process.execPath, ['test/fixtures/ui/gen-large-city.mjs', '--preset', 'large', '--out', out]);
  large = JSON.parse(readFileSync(out, 'utf8')) as Report;
});

describe('perf/layout-2000-files-under-50ms', () => {
  it('lays out the large preset in under 50 ms (median of 9 runs)', () => {
    const files = large.packages.reduce((sum, pkg) => sum + pkg.files.length, 0);
    const floors = large.packages.reduce((sum, pkg) => sum + pkg.files.reduce((n, file) => n + file.symbols.length, 0), 0);
    expect(files).toBe(2000);
    expect(floors).toBeGreaterThan(19_000);
    expect(floors).toBeLessThan(21_000);
    expect(large.packages).toHaveLength(40);
    expect(large.packages.flatMap((pkg) => pkg.files).filter((file) => file.status !== 'same')).toHaveLength(300);

    buildCity(large);
    const times: number[] = [];
    for (let run = 0; run < 9; run += 1) {
      const start = performance.now();
      const city = buildCity(large);
      times.push(performance.now() - start);
      expect(city.buildings).toHaveLength(2000);
    }
    expect(median(times)).toBeLessThan(50);
  });

  it('is deterministic: the same preset and seed make the same Report', () => {
    const again = join(mkdtempSync(join(tmpdir(), 'diffcity-large-')), 'again.json');
    execFileSync(process.execPath, ['test/fixtures/ui/gen-large-city.mjs', '--preset', 'large', '--out', again]);
    expect(JSON.parse(readFileSync(again, 'utf8'))).toEqual(large);
  });
});

describe('quality ladder (scene/quality.ts)', () => {
  it('keeps full quality at 58 fps and above', () => {
    expect(levelFor(60).level).toBe(0);
    expect(levelFor(58).level).toBe(0);
    expect(levelFor(120).level).toBe(0);
  });

  it('applies the fallbacks in order as the frame rate falls', () => {
    expect(levelFor(57.9)).toEqual({ level: 1, msaa: 2, bloomScale: 0.5, environment: true });
    expect(levelFor(50)).toMatchObject({ level: 1 });
    expect(levelFor(49)).toEqual({ level: 2, msaa: 2, bloomScale: 0.25, environment: true });
    expect(levelFor(41)).toEqual({ level: 3, msaa: 2, bloomScale: 0.25, environment: false });
    expect(levelFor(0).level).toBe(3);
    expect(QUALITY_LEVELS.map((level) => level.level)).toEqual([0, 1, 2, 3]);
  });

  it('reads the median frame rate from frame intervals, and too few intervals as 0 fps', () => {
    expect(medianFps([16, 17, 16, 100, 16])).toBeCloseTo(62.5, 0);
    expect(medianFps([1000, 1000])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

/** Drives a probe on a fake clock: `frames` frames `ms` apart, ticking each time. Returns the time after the last one. */
function run(probe: QualityProbe, from: number, frames: number, ms: number): number {
  let now = from;
  for (let i = 0; i < frames; i += 1) {
    now += ms;
    probe.frame(now);
    probe.tick(now);
  }
  return now;
}

describe('quality probe state machine (scene/quality.ts)', () => {
  const frames = WARMUP_FRAMES + Math.ceil(PROBE_MS / 16) + 4;

  it('a probe that ran visible ends with the level its frame rate gives', () => {
    const probe = new QualityProbe(true, 0);
    run(probe, 0, frames, 16);
    expect(probe.fps).toBeGreaterThan(58);
    expect(levelFor(probe.fps ?? 0).level).toBe(0);
  });

  it('too few frames in a probe that ran visible means the lowest level', () => {
    const probe = new QualityProbe(true, 0);
    run(probe, 0, 6, 1000);
    probe.tick(100_000);
    probe.tick(200_000);
    expect(probe.fps).toBe(0);
    expect(levelFor(probe.fps ?? 0).level).toBe(3);
  });

  it('hiding the tab mid-probe voids it; shown again it runs afresh and ends at the visible level', () => {
    const probe = new QualityProbe(true, 0);
    let now = run(probe, 0, WARMUP_FRAMES + 5, 16);
    probe.visibility(false, now);
    // Hidden: no frames, but time passes and ticks arrive. Nothing ends, nothing is pinned.
    now += 5000;
    expect(probe.tick(now)).toBe(false);
    expect(probe.fps).toBeNull();
    expect(probe.running).toBe(false);
    probe.visibility(true, now);
    expect(probe.running).toBe(true);
    run(probe, now, frames, 16);
    expect(levelFor(probe.fps ?? 0).level).toBe(0);
  });

  it('a tab hidden at mount starts the probe on the first show', () => {
    const probe = new QualityProbe(false, 0);
    expect(probe.running).toBe(false);
    probe.frame(10);
    expect(probe.tick(10_000)).toBe(false);
    expect(probe.fps).toBeNull();
    probe.visibility(true, 10_000);
    expect(probe.running).toBe(true);
    run(probe, 10_000, frames, 16);
    expect(levelFor(probe.fps ?? 0).level).toBe(0);
  });

  it('ends once: later frames, ticks and visibility changes leave the result alone', () => {
    const probe = new QualityProbe(true, 0);
    run(probe, 0, frames, 16);
    const fps = probe.fps;
    probe.visibility(false, 99_999);
    probe.visibility(true, 100_000);
    run(probe, 100_000, 50, 100);
    expect(probe.fps).toBe(fps);
    expect(probe.running).toBe(false);
  });
});
