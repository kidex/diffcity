// The collector worker thread (ADR-021): thin, it only calls src/core. Loaded
// by the pool's `thread` runner from dist/daemon/collector/worker.js; each
// worker keeps its wasm grammars loaded between jobs.

import { parentPort } from 'node:worker_threads';
import { computeSnapshot, type SnapshotJobInput } from '../../core/report/snapshot.js';
import { isJobRequest, type JobReply } from './worker-protocol.js';

const port = parentPort;
if (port === null) throw new Error('worker.ts runs only as a worker thread');

port.on('message', (message: unknown) => {
  if (!isJobRequest(message)) return;
  const { id } = message;
  computeSnapshot(message.input as SnapshotJobInput).then(
    (result) => {
      const reply: JobReply<typeof result> = { id, ok: true, result };
      port.postMessage(reply);
    },
    (error: unknown) => {
      const reply: JobReply<never> = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      port.postMessage(reply);
    },
  );
});
