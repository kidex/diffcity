export function priceWithTax(amount: number, rate = 0.2): number {
  return amount * (1 + rate);
}
