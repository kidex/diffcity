import { startServer } from '../daemon/server.js';
import { jobs } from '../daemon/jobs.mjs';
export function postEntry(amount: number): number {
  return startServer(amount + jobs.length);
}
