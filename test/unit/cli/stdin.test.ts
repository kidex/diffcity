// Bounded stdin reads for `track --agent` (SPEC.md section 3: the hook JSON is at most 64 KB).

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readStdin } from '../../../src/cli/stdin.js';

describe('readStdin', () => {
  it('reads until the stream ends', async () => {
    const stream = new PassThrough();
    const reading = readStdin(stream, 1024);
    stream.write('{"session_id":');
    stream.end('"session-0001"}');
    expect(await reading).toBe('{"session_id":"session-0001"}');
  });

  it('stops once more than maxBytes arrived, without waiting for the end', async () => {
    const stream = new PassThrough();
    const reading = readStdin(stream, 8);
    stream.write('0123456789');
    const text = await reading;
    expect(Buffer.byteLength(text)).toBeGreaterThan(8);
  });

  it('gives up on a stream that is never closed', async () => {
    await expect(readStdin(new PassThrough(), 1024, 50)).rejects.toThrow('stdin was not closed within 0.05 s');
  });

  it('passes stream errors on', async () => {
    const stream = new PassThrough();
    const reading = readStdin(stream, 1024);
    stream.destroy(new Error('sample read failure'));
    await expect(reading).rejects.toThrow('sample read failure');
  });
});
