import { fee, price } from './price';

export function quote(): number {
  return price(1) + price(2) + fee(3);
}

export const total = price(4);
