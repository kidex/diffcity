export interface Program {
  command(name: string, run: (args: string[]) => void | Promise<void>): void;
}
