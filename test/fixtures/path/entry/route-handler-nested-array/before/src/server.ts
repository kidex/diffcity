import { requireCourier } from './auth';
import { listParcels, parcelLabels } from './parcels';

declare const app: { get(path: string, ...handlers: unknown[]): void };

app.get('/parcels', [[requireCourier], [[listParcels]]]);
// An array with no handler in it registers nothing.
app.get('/labels', ['parcelLabels']);

export const labels = parcelLabels;
