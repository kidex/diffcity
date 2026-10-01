import { Program } from '../program.js';
import { formatDuration } from '../format/duration.js';

export function registerList(program: Program): void {
  program.command('list', (args) => {
    for (const job of args) process.stdout.write(`${job} ${formatDuration(1000)}\n`);
  });
}
