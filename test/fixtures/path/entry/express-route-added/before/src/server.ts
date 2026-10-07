interface App {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}

import { listItems } from './items';

export function registerRoutes(app: App): void {
  app.get('/items', listItems);
}
