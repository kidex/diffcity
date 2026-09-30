import { describe, expect, it } from 'vitest';
import { looksBinary } from '../../src/core/git/index.js';

function withNulAt(index: number, length = 9000): Buffer {
  const bytes = Buffer.alloc(length, 0x61);
  bytes[index] = 0;
  return bytes;
}

describe('looksBinary (git heuristic: NUL in the first 8000 bytes)', () => {
  it('is binary with a NUL in the first 8000 bytes', () => {
    expect(looksBinary(withNulAt(0))).toBe(true);
    expect(looksBinary(withNulAt(7999))).toBe(true);
  });

  it('is not binary with a NUL only after byte 8000', () => {
    expect(looksBinary(withNulAt(8000))).toBe(false);
  });

  it('is not binary for text or empty content', () => {
    expect(looksBinary(Buffer.from('export const a = 1;\n'))).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});
