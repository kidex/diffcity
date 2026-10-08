import { journal } from './books/journal.js';
export function postEntry(amount: number): number {
  journal.push(amount);
  return amount;
}
