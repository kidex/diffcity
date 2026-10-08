import { renderPanel } from '../ui/panel.js';

export function runCli(args: string[]): number {
  return renderPanel(args.join()).length;
}
