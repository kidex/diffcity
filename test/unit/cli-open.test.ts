// `up` opens the browser with `open` (macOS) or `xdg-open` (Linux), through
// execFile only, never a shell (ADR-015).

import { describe, expect, it } from 'vitest';
import { browserCommand, openBrowser, type ExecFileLike } from '../../src/cli/open.js';

function recorder(error: Error | null = null): { calls: [string, readonly string[]][]; execFile: ExecFileLike } {
  const calls: [string, readonly string[]][] = [];
  return {
    calls,
    execFile: (file, args, callback) => {
      calls.push([file, args]);
      callback(error);
    },
  };
}

describe('openBrowser', () => {
  it('uses open on macOS and xdg-open on Linux, with the URL as the only argument', async () => {
    expect(browserCommand('darwin')).toBe('open');
    expect(browserCommand('linux')).toBe('xdg-open');
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, execFile } = recorder();
      expect(await openBrowser('http://127.0.0.1:4321', { platform, execFile })).toBe(true);
      expect(calls).toEqual([[browserCommand(platform), ['http://127.0.0.1:4321']]]);
    }
  });

  it('reports false on an unsupported platform or a failing command', async () => {
    const unsupported = recorder();
    expect(await openBrowser('http://127.0.0.1:4321', { platform: 'win32', execFile: unsupported.execFile })).toBe(false);
    expect(unsupported.calls).toEqual([]);
    const failing = recorder(new Error('no xdg-open'));
    expect(await openBrowser('http://127.0.0.1:4321', { platform: 'linux', execFile: failing.execFile })).toBe(false);
  });
});
