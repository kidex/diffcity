export class Cashier {
  static #instances = 0;

  constructor(private readonly till: string) {}

  get balance(): number {
    return 0;
  }

  set balance(value: number) {
    void value;
  }

  protected static async *drain(limit = 10): AsyncGenerator<number> {
    yield limit;
  }

  #audit(note: string): void {
    console.log(note);
  }

  @logged
  onClose = async (reason: string) => {
    this.#audit(reason);
  };

  refund(amount: number): void;
  refund(amount: string): void;
  refund(amount: number | string): void {
    void amount;
  }

  label = 'till';
}

export abstract class Drawer {
  abstract open(): void;
}
