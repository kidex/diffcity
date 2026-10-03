// The daemon script (ADR-015): `node dist/daemon/main.js [--port <n>] [--foreground]`.
// It is not a CLI command, so `diffcity --help` keeps exactly the commands of
// SPEC.md section 3. `up` and `track` start it detached; the log goes to
// daemon.log, or to stderr with --foreground.

import { parseArgs } from 'node:util';
import { isPort } from './files.js';
import { createStreamLogger } from './log.js';
import { STARTUP_STAGES, type StartupStage } from './daemon.js';
import { daemonUrl, runDaemon } from './run.js';

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

async function main(): Promise<number> {
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
  } catch (error) {
    process.stderr.write(`diffcity daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return runDaemon(
    { ...(port === undefined ? {} : { port }), ...(foreground ? { log: createStreamLogger(process.stderr) } : {}) },
    {
      err: (text) => process.stderr.write(text),
      ...(pauseAt === undefined ? {} : { onStage: pauseStage }),
      onReady: (info, alreadyRunning) => {
        const where = `${daemonUrl(info)} (pid ${String(info.pid)})`;
        process.stdout.write(alreadyRunning ? `daemon already running at ${where}\n` : `diffcity daemon listening on ${where}\n`);
      },
    },
  );
}

// Exit explicitly, once stdout and stderr are flushed: a plugin that leaves a
// handle open must not keep a stopped daemon alive.
const exitCode = await main();
process.stdout.write('', () => {
  process.stderr.write('', () => process.exit(exitCode));
});
