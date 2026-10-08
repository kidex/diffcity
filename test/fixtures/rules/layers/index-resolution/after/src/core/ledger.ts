import { startServer } from '../daemon';
export function postEntry(amount: number): number {
  return startServer(amount);
}
