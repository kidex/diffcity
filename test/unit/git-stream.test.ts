// gitStream (ADR-024 layer): stdout goes to a callback, never into memory, so a
// blob larger than GIT_MAX_BUFFER (512 MB) can still be hashed.

import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const chunk = Buffer.alloc(1024 * 1024, 7);
const CHUNKS = 600; // 600 MB, more than gitRaw's 512 MB buffer

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcess>();
  return {
    ...original,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
      setImmediate(() => {
        for (let i = 0; i < CHUNKS; i += 1) child.stdout.emit('data', chunk);
        child.emit('close', 0);
      });
      return child;
    },
  };
});

const { gitStream } = await import('../../src/core/git/exec.js');

describe('gitStream', () => {
  it('hashes more than 512 MB without buffering it, and equals the buffered hash', async () => {
    const hash = createHash('sha256');
    let seen = 0;
    const result = await gitStream('/work/sample-shop', ['cat-file', 'blob', 'abc:big.bin'], (data) => {
      hash.update(data);
      seen += data.length;
    });
    expect(result.exitCode).toBe(0);
    expect(seen).toBe(CHUNKS * chunk.length);
    const expected = createHash('sha256');
    for (let i = 0; i < CHUNKS; i += 1) expected.update(chunk);
    expect(hash.digest('hex')).toBe(expected.digest('hex'));
  }, 60_000);

  it('refuses a subcommand that may run a filter driver', () => {
    expect(() => gitStream('/work/sample-shop', ['diff', 'a', 'b'], () => undefined)).toThrow(/filter driver/);
  });
});
