import { startServer } from '#daemon/server';
import { renderPanel } from '#ui/panel';
export function postEntry(amount: number): number {
  return startServer(amount) + renderPanel("x").length;
}
