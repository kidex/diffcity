import { formatDuration } from '../format/duration.js';
import type { Program } from '../program.js';

export function registerList(program: Program): void {
  program.command('list', (args) => {
    for (const job of args) process.stdout.write(`${job} ${formatDuration(1000)}\n`);
  });
}
