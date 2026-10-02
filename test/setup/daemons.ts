// vitest setupFiles entry (DC-58): after every test file, stops any process
// still running with a home that file registered (test/helpers/daemons.ts).
// A backstop behind DaemonTracker.cleanup() in afterEach: it catches a daemon
// started after that cleanup (by a stray `track`) or left by a cleanup that
// did not finish. The global teardown sweeps the whole run after this.

import { afterAll } from 'vitest';
import { forgetRegistered, registeredHere, sweepHomes } from '../helpers/daemons.js';

afterAll(async () => {
  const { homes, pids } = registeredHere();
  await sweepHomes(homes, { pids });
  forgetRegistered();
});
