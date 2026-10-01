export function formatAmount(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

export function formatAccount(account: string): string {
  return account.trim().toUpperCase();
}

export const DEFAULT_CURRENCY = 'EUR';
