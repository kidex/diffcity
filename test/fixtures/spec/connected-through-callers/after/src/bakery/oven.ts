import { stoke } from './fire';

export function bake(minutes: number): number {
  return stoke(minutes) + 1;
}
