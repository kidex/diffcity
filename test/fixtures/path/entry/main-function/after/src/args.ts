export function parseArgs(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith('--'));
}
