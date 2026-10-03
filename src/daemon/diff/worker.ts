// The diff worker thread (ADR-027): thin, it only calls src/core. Loaded by
// the diff pool's `thread` runner from dist/daemon/diff/worker.js; each worker
// keeps its wasm grammars loaded between jobs.

import { parentPort } from 'node:worker_threads';
import { runDiffJob, type DiffJob } from '../../core/diff/index.js';
import { isJobRequest, type JobReply } from '../collector/worker-protocol.js';

const port = parentPort;
if (port === null) throw new Error('worker.ts runs only as a worker thread');

port.on('message', (message: unknown) => {
  if (!isJobRequest(message)) return;
  const { id } = message;
  runDiffJob(message.input as DiffJob).then(
    (result) => {
      const reply: JobReply<string> = { id, ok: true, result };
      port.postMessage(reply);
    },
    (error: unknown) => {
      const reply: JobReply<never> = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      port.postMessage(reply);
    },
  );
});
