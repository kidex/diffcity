import { bake } from './oven';

export function openShop(hour: number): number {
  return bake(hour) + 1;
}
