import type { Job } from '../daemon/queue.js';
import { type Job as Task } from '../daemon/queue.js';
export type { Job as QueuedJob } from '../daemon/queue.js';
export function postEntry(amount: number): number {
  const job: Job | Task | null = null;
  return job === null ? amount : 0;
}
