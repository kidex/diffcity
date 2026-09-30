export class AccountBook {
  private readonly names = new Set<string>();

  open(name: string): void {
    this.names.add(name);
  }

  has(name: string): boolean {
    return this.names.has(name);
  }
}
