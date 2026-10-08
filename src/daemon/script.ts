// The body of the daemon script (ADR-015): `node dist/daemon/main.js [--port
// <n>] [--foreground]`. It is not a CLI command, so `diffcity --help` keeps
// exactly the commands of SPEC.md section 3. `up` and `track` start it
// detached; the log goes to daemon.log, or to stderr with --foreground.
// main.ts loads this module after installing the start reporter (DC-45), so
// that a failure to load it is reported too.

import { parseArgs } from 'node:util';
import { homePaths, resolveHome } from '../core/home.js';
import { isPort } from './files.js';
import { createStreamLogger } from './log.js';
import { STARTUP_STAGES, type StartupStage } from './daemon.js';
import { daemonUrl, runDaemon } from './run.js';
import { sweepStartReports, type StartReport } from './start-report.js';

/**
 * Test-only seam: with DIFFCITY_TEST=1 and DIFFCITY_TEST_PAUSE_AT=<stage>
 * the startup prints `paused <stage>` on stdout and waits there until
 * SIGINT/SIGTERM aborts it, so a test can deliver a signal at a chosen
 * startup stage. Without DIFFCITY_TEST=1 the pause variable is ignored.
 */
const PAUSE_ENV = 'DIFFCITY_TEST_PAUSE_AT';
const pauseAt =
  process.env['DIFFCITY_TEST'] === '1' ? STARTUP_STAGES.find((stage) => stage === process.env[PAUSE_ENV]) : undefined;

async function pauseStage(stage: StartupStage, signal: AbortSignal): Promise<void> {
  if (stage !== pauseAt || signal.aborted) return;
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve(); }, { once: true });
  });
  // Nothing else may be open yet, and a pending promise does not keep the process alive.
  const keepAlive = setInterval(() => undefined, 1000);
  process.stdout.write(`paused ${stage}\n`);
  await aborted;
  clearInterval(keepAlive);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!isPort(port)) throw new Error(`invalid --port: ${value}`);
  return port;
}

/**
 * Runs the daemon until it stops; resolves with the process exit code.
 * `onSignalsHandled` is called once the daemon handles SIGTERM and SIGINT
 * (RunDaemonHooks.onSignalsHandled).
 */
export async function runDaemonScript(reportStart: (outcome: StartReport) => void, onSignalsHandled?: () => void): Promise<number> {
  let port: number | undefined;
  let foreground: boolean;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { port: { type: 'string' }, foreground: { type: 'boolean', default: false } },
      strict: true,
    });
    port = parsePort(values.port);
    foreground = values.foreground;
    // Start reports a killed client or daemon left behind (start-report.ts).
    sweepStartReports(homePaths(resolveHome(process.env)).home);
  } catch (error) {
    process.stderr.write(`diffcity daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return runDaemon(
    { ...(port === undefined ? {} : { port }), ...(foreground ? { log: createStreamLogger(process.stderr) } : {}) },
    {
      err: (text) => process.stderr.write(text),
      ...(onSignalsHandled === undefined ? {} : { onSignalsHandled }),
      ...(pauseAt === undefined ? {} : { onStage: pauseStage }),
      onReady: (info, alreadyRunning) => {
        if (!alreadyRunning) reportStart('ready');
        const where = `${daemonUrl(info)} (pid ${String(info.pid)})`;
        process.stdout.write(alreadyRunning ? `daemon already running at ${where}\n` : `diffcity daemon listening on ${where}\n`);
      },
    },
  );
}
