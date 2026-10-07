import { price } from './price';

export function total(a: number, b: number): number {
  return price(a) + price(b);
}

export function single(a: number): number {
  return price(a);
}
