import type { Job } from '../daemon/queue.js';
export function postEntry(amount: number): number {
  const job: Job | null = null;
  return job === null ? amount : 0;
}
