import { createParcel, listParcels } from './parcels';

const table: [string, () => unknown][] = [
  ['/parcels', listParcels],
  ['/parcels/new', createParcel],
];

export function health(): string {
  return 'ok';
}

export function registerRoutes(app: { get: (...args: unknown[]) => void }): void {
  for (const [path, handler] of table) app.get(path, handler);
  app.get('/health', health);
}
