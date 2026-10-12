import { getOrder } from '../orders/lookup';

interface Router {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}

export function registerRoutes(router: Router): void {
  router.get('/orders/:id', getOrder);
}
