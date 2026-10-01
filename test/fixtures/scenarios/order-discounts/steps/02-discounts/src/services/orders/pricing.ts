import { Money } from '../../shared/money';

export function basePrice(sku: string): Money {
  return Money.of(sku.length * 100);
}

export function vat(amount: Money): Money {
  return amount.times(0.2);
}
