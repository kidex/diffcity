import { format, only } from './a.js';
import { format as other } from './b.js';

export function render(value) {
  return format(value) + other(value) + only(value) + '.';
}
