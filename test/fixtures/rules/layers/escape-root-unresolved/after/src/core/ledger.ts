import { secret } from '../../../outside/secret.js';
export function postEntry(amount: number): number {
  return amount + secret;
}
