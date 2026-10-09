import { refundOrder } from './refund';

export function cancelOrder(id: string): string {
  return refundOrder(id, 0, 'cancelled');
}
