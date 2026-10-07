import { Ledger } from './ledger';

export function post(ledger: Ledger, amount: number): number {
  return ledger.record(amount);
}

export class Desk {
  private readonly book: Ledger;

  constructor(book: Ledger) {
    this.book = book;
  }

  close(): number {
    return this.book.record(1);
  }
}
