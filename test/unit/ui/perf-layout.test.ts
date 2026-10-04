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
import { levelFor, median, medianFps, QUALITY_LEVELS } from '../../../src/ui/screens/change/scene/quality.js';

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
