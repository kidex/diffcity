import { startServer } from '../daemon/server.js';
export function postEntry(amount: number): number {
  return startServer(amount + 1);
}
