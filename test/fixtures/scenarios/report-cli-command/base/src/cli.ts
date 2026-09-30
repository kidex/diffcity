import * as commands from './commands/index.js';
import type { Program } from './program.js';

export async function main(argv: string[]): Promise<number> {
  const handlers = new Map<string, (args: string[]) => void | Promise<void>>();
  const program: Program = { command: (name, run) => void handlers.set(name, run) };
  for (const register of Object.values(commands)) register(program);
  const [name = 'status', ...rest] = argv;
  const run = handlers.get(name);
  if (run === undefined) return 2;
  await run(rest);
  return 0;
}
