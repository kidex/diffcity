// Bounded stdin reads for commands that take a small JSON payload on stdin
// (`track --agent` reads the Claude Code hook input, SPEC.md section 3).

import type { Readable } from 'node:stream';

/** A writer that keeps stdin open without sending anything is given up on after this long. */
export const STDIN_TIMEOUT_MS = 2000;

/**
 * Reads `stream` until it ends, or until more than `maxBytes` bytes arrived
 * (the result is then `maxBytes` + 1 bytes or more, so the caller can tell it
 * is oversized). Rejects when nothing ends the read within `timeoutMs`.
 */
export function readStdin(stream: Readable, maxBytes: number, timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      fn();
    };
    const text = (): string => Buffer.concat(chunks).toString('utf8');
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buffer);
      size += buffer.length;
      if (size > maxBytes) {
        done(() => {
          resolve(text());
        });
      }
    };
    const onEnd = (): void => {
      done(() => {
        resolve(text());
      });
    };
    const onError = (error: Error): void => {
      done(() => {
        reject(error);
      });
    };
    const timer = setTimeout(() => {
      done(() => {
        reject(new Error(`stdin was not closed within ${String(timeoutMs / 1000)} s`));
      });
    }, timeoutMs);
    // Unref'd: a stdin read must not by itself keep the process alive.
    timer.unref();
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}
