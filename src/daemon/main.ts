// The daemon script (ADR-015): `node dist/daemon/main.js [--port <n>] [--foreground]`.
// It is not a CLI command, so `diffcity --help` keeps exactly the commands of
// SPEC.md section 3. `up` and `track` start it detached; the log goes to
// daemon.log, or to stderr with --foreground.

import { parseArgs } from 'node:util';
import { isPort } from './files.js';
import { createStreamLogger } from './log.js';
import { runDaemon } from './run.js';

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
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    },
  );
}

// Exit explicitly, once stdout and stderr are flushed: a plugin that leaves a
// handle open must not keep a stopped daemon alive.
const exitCode = await main();
process.stdout.write('', () => {
  process.stderr.write('', () => process.exit(exitCode));
});
