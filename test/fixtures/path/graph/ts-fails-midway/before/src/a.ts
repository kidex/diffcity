import type { Book } from './book';
import { price } from './price';

export function quote(book: Book): number {
  return book.record(price(1)) + price(2);
}
