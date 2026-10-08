// The daemon script (ADR-015): `node dist/daemon/main.js [--port <n>] [--foreground]`.
// This entry imports node builtins and the start reporter only. It installs
// the reporter first (DC-45), then loads the daemon itself: a daemon that
// cannot load its modules (a partial dist/, a node without node:sqlite) still
// tells a client that launched it through LaunchServices that it exited with 1,
// instead of leaving it to wait for its start timeout.
//
// Loading the daemon takes seconds on a busy machine, and run.ts handles
// SIGTERM and SIGINT only once it is loaded. Until then this entry handles
// them (DC-119): nothing of the daemon exists yet (no lock, no socket, no
// daemon.json), so a signal ends the process at once with 0, which the start
// report records, instead of the default action of the signal.

import { takeStartReporter } from './start-report.js';

const reportStart = takeStartReporter(process.env);
process.on('exit', (code) => {
  reportStart(code);
});

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** True until the daemon handles the signals itself. */
let beforeDaemon = true;
// Stays installed for the life of the process, so that no signal ever meets
// the default action; once the daemon has taken the signals over it does
// nothing, and after the daemon has stopped the exit below is under way.
const onSignal = (): void => {
  if (beforeDaemon) process.exit(0);
};
for (const name of SIGNALS) process.on(name, onSignal);

let exitCode: number;
try {
  const { runDaemonScript } = await import('./script.js');
  exitCode = await runDaemonScript(reportStart, () => {
    beforeDaemon = false;
  });
} catch (error) {
  process.stderr.write(`diffcity daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  exitCode = 1;
}
beforeDaemon = false;

// Exit explicitly, once stdout and stderr are flushed: a plugin that leaves a
// handle open must not keep a stopped daemon alive.
process.stdout.write('', () => {
  process.stderr.write('', () => process.exit(exitCode));
});
