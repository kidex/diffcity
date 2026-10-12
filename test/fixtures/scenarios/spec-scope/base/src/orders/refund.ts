import { formatCents } from '../shared/money';

export function refundOrder(id: string, cents: number): string {
  return `refund ${formatCents(cents)} for ${id}`;
}
