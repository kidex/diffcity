export function heat(level: number, fan: boolean): number {
  return fan ? level * 12 : level * 10;
}

export function vent(): string {
  return 'open';
}
