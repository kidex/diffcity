// A pool worker for the pool tests, speaking the collector's job protocol:
// { id, input } in, { id, ok: true, result } or { id, ok: false, error } out.
// input: { value, ms?, busy?, hang?, crash?, fail? }
//   ms    wait that long first (a timer, or a CPU loop when busy)
//   hang  never answer
//   crash exit the worker thread
//   fail  answer with an error

import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', async ({ id, input }) => {
  if (input.hang) return;
  if (input.crash) process.exit(3);
  const ms = input.ms ?? 0;
  if (input.busy) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // Keep the CPU busy, as a large parse would.
    }
  } else if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (input.fail) parentPort.postMessage({ id, ok: false, error: `sample failure: ${input.value}` });
  else parentPort.postMessage({ id, ok: true, result: { value: input.value, threadId } });
});
