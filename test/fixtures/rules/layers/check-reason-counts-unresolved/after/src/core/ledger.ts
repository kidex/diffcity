import { startServer } from '../daemon/server.js';
import { gone } from './gone.js';
import { lost } from '@lost/thing';
export function postEntry(amount: number): number {
  return startServer(amount) + gone + lost;
}

export function loadPart(name: string): unknown {
  return require(name);
}
