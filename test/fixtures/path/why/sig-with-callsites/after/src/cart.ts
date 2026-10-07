import { price } from './price';

export function total(a: number, b: number): number {
  return price(a, 1.2) + price(b, 1.2);
}

export function single(a: number): number {
  return price(a, 1.2);
}
