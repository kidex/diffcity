export class Money {
  private constructor(readonly cents: number) {}

  static of(cents: number): Money {
    return new Money(cents);
  }

  static zero(): Money {
    return new Money(0);
  }

  plus(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  times(factor: number): Money {
    return new Money(this.cents * factor);
  }
}

export function round(amount: Money): Money {
  return Money.of(Math.round(amount.cents));
}
