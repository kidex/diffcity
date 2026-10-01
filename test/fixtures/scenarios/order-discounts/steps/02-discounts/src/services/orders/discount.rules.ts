import { Money } from '../../shared/money';

export interface DiscountRule {
  percentage(total: Money): number;
}

export function percentage(pct: number): DiscountRule {
  return { percentage: () => pct };
}

export function threshold(minimum: Money, pct: number): DiscountRule {
  return { percentage: (total) => (total.cents >= minimum.cents ? pct : 0) };
}
