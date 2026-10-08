import { startServer } from '../daemon/server.js';
export function postEntry(amount: number): number {
  const opening = 0;
  const closing = 0;
  return startServer(amount + opening + closing);
}
