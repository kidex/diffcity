import { seed } from '../../scripts/seed.js';
export function postEntry(amount: number): number {
  return amount + seed;
}
