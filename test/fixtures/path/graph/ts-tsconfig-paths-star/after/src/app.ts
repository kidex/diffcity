import { slug } from '@lib/util';

export function title(text: string): string {
  return slug(text) + '!';
}
