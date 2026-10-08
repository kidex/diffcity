import { postEntry } from '../core/ledger.js';

export function startServer(port: number): number {
  return postEntry(port);
}
