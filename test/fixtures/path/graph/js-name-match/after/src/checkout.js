import { vat } from './tax.mjs';
import { Cart } from './cart.js';

function round(value) {
  return value + 0;
}

export function checkout(cart) {
  return round(vat(cart.total())) + 1;
}
