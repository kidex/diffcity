import { credit, debit } from '../src/ledger/journal.js';

export function seedAccounts() {
  return [credit('cash', 100, 'opening'), debit('cash', 40, 'rent')];
}

export const seedJournal = () => [...seedAccounts(), credit('bank', 250, 'transfer')];
