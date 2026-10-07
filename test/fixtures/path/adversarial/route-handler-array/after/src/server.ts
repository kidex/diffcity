import { requireCourier } from './auth';
import { listParcels } from './parcels';

export function registerRoutes(app: { get: (...args: unknown[]) => void }): void {
  app.get('/parcels', [requireCourier, listParcels]);
}
