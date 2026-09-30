export class Oven {
  heat(level: number): number {
    return level * 10;
  }

  cool(): number {
    return 0;
  }
}
