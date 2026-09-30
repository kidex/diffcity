#!/usr/bin/env node
import { buildProgram } from './program.js';

// A reader that closes the pipe early (`diffcity diff --json | head`) is not an
// error: stop quietly instead of crashing on EPIPE.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

await buildProgram().parseAsync(process.argv);
