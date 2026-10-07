import { listItems } from './items';

declare const app: { get(path: string, ...handlers: unknown[]): void };

app.get('/items', listItems);
