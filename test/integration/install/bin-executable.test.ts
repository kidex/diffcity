import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

describe('install', () => {
  it('install/bin-executable: every built bin entry is executable', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    for (const bin of Object.values(pkg.bin)) {
      expect(statSync(join(root, bin)).mode & 0o111, bin).not.toBe(0);
    }
  });
});
