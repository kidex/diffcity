import { startServer } from '../daemon/server';
export function postEntry(amount: number): number {
  return startServer(amount);
}
