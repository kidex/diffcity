export class BillingController {
  constructor(private readonly rate: number) {
    this.rate = rate;
  }

  refund(amount: number): number {
    return amount * this.rate;
  }
}

export class BillingHelper {
  calc(amount: number): number {
    return amount + 1;
  }
}
