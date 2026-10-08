import { startServer } from '../../daemon/server.js';
import { renderPanel } from '../../ui/panel.js';
export function postEntry(amount: number): number {
  const opening = 0;
  const closing = renderPanel("x").length;
  return startServer(amount + opening + closing);
}
