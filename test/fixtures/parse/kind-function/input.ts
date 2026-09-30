export function priceWithTax(amount: number, rate = 0.2): number {
  return amount * (1 + rate);
}

async function* streamInvoices(ids: string[]) {
  for (const id of ids) yield id;
}

export function roundCents(value: string): number;
export function roundCents(value: number): number;
export function roundCents(value: string | number): number {
  return Math.round(Number(value) * 100) / 100;
}

export default function () {
  return 'anonymous';
}
