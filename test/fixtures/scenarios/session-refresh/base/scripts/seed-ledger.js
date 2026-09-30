import { credit, debit } from '../src/ledger/entries.js';

export function seedAccounts() {
  return [credit('cash', 100, 'opening'), debit('cash', 40, 'rent')];
}
