@sealed
export abstract class InvoiceBook<T> extends LedgerBase implements Printable {
  private readonly entries: T[] = [];

  count(): number {
    return this.entries.length;
  }
}

export default class {
  label = 'anonymous';
}

class Unexported {}
