export function postEntry(amount: number): number {
  return amount;
}

export async function loadServer(): Promise<unknown> {
  const mod = await import('../daemon/server.js');
  return mod;
}
