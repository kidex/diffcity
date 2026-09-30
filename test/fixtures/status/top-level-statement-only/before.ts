import { register } from './registry';

export function decorate(cake: string): string {
  return cake;
}

register('decorate', decorate);
