/**
 * Formatting helpers for ledger amounts and account names.
 */

export function formatAmount(
  amount: number,
  currency: string
): string {
  // Currency first, always two decimals.
  return `${currency} ${amount.toFixed(2)}`;
}

export function formatAccount(account: string): string {
    return account
        .trim()
        .toUpperCase();
}

/* Used when an entry carries no currency. */
export const DEFAULT_CURRENCY =
  'EUR';
