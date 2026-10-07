export function price(amount: number, rate: number): number {
  return amount * rate;
}

export function fee(amount: number): number {
  return amount + 1;
}
