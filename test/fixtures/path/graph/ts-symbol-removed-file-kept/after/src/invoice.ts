import { rate } from './rates';

export function total(): number {
  return rate() * 2;
}
