import { startServer } from '../daemon/server.js';
import { enqueue } from '../daemon/queue.js';
import { runCli } from '../cli/run.js';
export function postEntry(amount: number): number {
  return startServer(amount);
}
