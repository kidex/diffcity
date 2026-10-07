import { Parser } from './parser';

export function load(text: string): string {
  const parser = new Parser();
  return parser.parse(text + '\n');
}
