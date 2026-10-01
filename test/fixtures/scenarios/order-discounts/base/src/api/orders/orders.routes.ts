import type { OrdersController } from './orders.controller';
import type { OrderGuard } from '../../auth/order.guard';

interface Router {
  get(path: string, ...handlers: unknown[]): void;
  post(path: string, ...handlers: unknown[]): void;
}

export function registerRoutes(router: Router, ctrl: OrdersController, guard: OrderGuard): void {
  router.get('/orders', ctrl.list);
  router.get('/orders/:id', ctrl.get);
  router.post('/orders', guard.canPlace, ctrl.create);
}
