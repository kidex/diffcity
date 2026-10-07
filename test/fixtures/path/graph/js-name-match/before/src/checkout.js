import { vat } from './tax.mjs';
import { Cart } from './cart.js';

function round(value) {
  return value;
}

export function checkout(cart) {
  return round(vat(cart.total()));
}
