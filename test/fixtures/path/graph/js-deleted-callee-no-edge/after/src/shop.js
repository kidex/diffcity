import { restock, kept } from './stock.js';

export function open() {
  return restock(kept(2));
}
