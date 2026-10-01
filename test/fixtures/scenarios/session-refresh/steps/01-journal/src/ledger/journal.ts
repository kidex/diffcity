export interface Entry {
  account: string;
  amount: number;
  memo: string;
}

export function debit(account: string, amount: number, memo = ''): Entry {
  return { account, amount: -amount, memo };
}

export function credit(account: string, amount: number, memo = ''): Entry {
  return { account, amount, memo };
}

export function balance(entries: Entry[], account: string): number {
  const total = entries.filter((e) => e.account === account).reduce((sum, e) => sum + e.amount, 0);
  return Math.round(total * 100) / 100;
}

export function describeEntry(entry: Entry): string {
  return `${entry.account} ${String(entry.amount)} ${entry.memo}`;
}

export function byAccount(entries: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const entry of entries) out.set(entry.account, [...(out.get(entry.account) ?? []), entry]);
  return out;
}
