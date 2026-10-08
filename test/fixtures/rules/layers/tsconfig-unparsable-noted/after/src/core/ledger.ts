import { startServer } from '../daemon/server.js';
import { enqueue } from '#daemon/queue';
export function postEntry(amount: number): number {
  return startServer(amount) + String(enqueue).length;
}
