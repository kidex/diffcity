// A snapshot worker that keeps its CPU busy for 3 s per job and then fails
// the job: it stands in for a large parse in pool/health-responsive-while-busy.

import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id }) => {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    // Busy, as a parse would be.
  }
  parentPort.postMessage({ id, ok: false, error: 'busy worker: no snapshot' });
});
