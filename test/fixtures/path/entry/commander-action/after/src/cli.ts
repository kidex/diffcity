import { program } from 'commander';
import { runExport } from './export';

export function setup(): void {
  program.command('list');
  program.command('export').action(runExport);
}

export function setupSync(): void {
  program.command('sync').action(async () => {
    await Promise.resolve();
  });
}
