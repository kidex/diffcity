import type { Program } from '../program.js';
import { formatDuration } from '../format/duration.js';

export type Period = 'day' | 'week';

export function parsePeriod(value: string): Period;
export function parsePeriod(value: undefined): undefined;
export function parsePeriod(value: string | undefined): Period | undefined {
  if (value === undefined) return undefined;
  return value === 'week' ? 'week' : 'day';
}

export async function runReport(period: Period = 'day'): Promise<string> {
  return `report for one ${period}, built in ${formatDuration(0)}`;
}

export function registerReport(program: Program): void {
  program.command('report', async (args) => {
    const [period] = args;
    process.stdout.write(`${await runReport(period === undefined ? undefined : parsePeriod(period))}\n`);
  });
}
