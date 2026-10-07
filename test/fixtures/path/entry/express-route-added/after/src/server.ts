interface App {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}

import { createItem, listItems } from './items';

export function registerRoutes(app: App): void {
  app.get('/items', listItems);
  app.post('/items', createItem);
}
