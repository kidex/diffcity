import { legacy } from './legacy';

export function boot(): number {
  return legacy() + 1;
}
