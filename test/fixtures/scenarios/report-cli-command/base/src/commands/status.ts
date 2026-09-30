import type { Program } from '../program.js';

export function registerStatus(program: Program): void {
  program.command('status', () => {
    process.stdout.write('ok\n');
  });
}
