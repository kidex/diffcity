// The daemon script (ADR-015): `node dist/daemon/main.js [--port <n>] [--foreground]`.
// This entry imports node builtins and the start reporter only. It installs
// the reporter first (DC-45), then loads the daemon itself: a daemon that
// cannot load its modules (a partial dist/, a node without node:sqlite) still
// tells a client that launched it through LaunchServices that it exited with 1,
// instead of leaving it to wait for its start timeout.

import { takeStartReporter } from './start-report.js';

const reportStart = takeStartReporter(process.env);
process.on('exit', (code) => {
  reportStart(code);
});

let exitCode: number;
try {
  const { runDaemonScript } = await import('./script.js');
  exitCode = await runDaemonScript(reportStart);
} catch (error) {
  process.stderr.write(`diffcity daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  exitCode = 1;
}

// Exit explicitly, once stdout and stderr are flushed: a plugin that leaves a
// handle open must not keep a stopped daemon alive.
process.stdout.write('', () => {
  process.stderr.write('', () => process.exit(exitCode));
});
