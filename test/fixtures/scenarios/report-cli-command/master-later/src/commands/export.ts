import type { Program } from '../program.js';

export function registerExport(program: Program): void {
  program.command('export', () => {
    process.stdout.write('exported\n');
  });
}
