import { type Job, enqueue } from '../daemon/queue.js';
export function postEntry(amount: number): number {
  enqueue({ id: 'a' } as Job);
  return amount;
}
