import { ping, walk } from './walk';

export function main(): number {
  return walk(3) + ping(2);
}
