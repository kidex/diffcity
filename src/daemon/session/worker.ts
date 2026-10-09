// The session worker thread (ADR-038, ADR-021): thin, it only calls
// src/core/session. Loaded by the session pool's `thread` runner from
// dist/daemon/session/worker.js. runSessionJob never rejects with a message
// that could carry a path; a crash here is reported as a code only.

import { parentPort } from 'node:worker_threads';
import { runSessionJob, type SessionJob } from '../../core/session/job.js';
import { isJobRequest, type JobReply } from '../collector/worker-protocol.js';

const port = parentPort;
if (port === null) throw new Error('worker.ts runs only as a worker thread');

port.on('message', (message: unknown) => {
  if (!isJobRequest(message)) return;
  const { id } = message;
  runSessionJob(message.input as SessionJob).then(
    (result) => {
      const reply: JobReply<typeof result> = { id, ok: true, result };
      port.postMessage(reply);
    },
    () => {
      const reply: JobReply<never> = { id, ok: false, error: 'read-failed' };
      port.postMessage(reply);
    },
  );
});
