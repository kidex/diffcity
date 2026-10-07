import { parseArgs } from './args';

export async function main(): Promise<number> {
  return parseArgs(['--dry']).length;
}
