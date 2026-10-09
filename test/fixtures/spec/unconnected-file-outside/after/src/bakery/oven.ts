import { weigh } from './scale';

export function bake(minutes: number): number {
  return weigh(minutes) + 5;
}
