// Opens a URL in the default browser (ADR-015): `open` on macOS, `xdg-open` on
// Linux, through execFile with the URL as a single argument, never a shell.

import { execFile as nodeExecFile } from 'node:child_process';

export type ExecFileLike = (file: string, args: readonly string[], callback: (error: Error | null) => void) => void;

export function browserCommand(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux') return 'xdg-open';
  return null;
}

const defaultExecFile: ExecFileLike = (file, args, callback) => {
  nodeExecFile(file, args, { timeout: 10_000 }, (error) => {
    callback(error);
  });
};

/** Resolves true once the opener ran successfully, false otherwise (unsupported platform included). */
export function openBrowser(
  url: string,
  { platform = process.platform, execFile = defaultExecFile }: { platform?: NodeJS.Platform; execFile?: ExecFileLike } = {},
): Promise<boolean> {
  const command = browserCommand(platform);
  if (command === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(command, [url], (error) => {
      resolve(error === null);
    });
  });
}
