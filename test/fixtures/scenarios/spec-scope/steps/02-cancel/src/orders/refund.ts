import { formatCents } from '../shared/money';

export function refundOrder(id: string, cents: number, reason: string): string {
  return `refund ${formatCents(cents)} for ${id} (${reason})`;
}
