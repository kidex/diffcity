export function postEntry(amount: number): number {
  return amount;
}

export async function loadPart(name: string): Promise<unknown> {
  return import(`../daemon/${name}.js`);
}
