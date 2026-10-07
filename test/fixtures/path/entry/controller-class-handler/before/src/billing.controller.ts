export class BillingController {
  constructor(private readonly rate: number) {}

  refund(amount: number): number {
    return amount;
  }
}

export class BillingHelper {
  calc(amount: number): number {
    return amount;
  }
}
