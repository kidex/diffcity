export class Pantry {
  count(): number {
    return 0;
  }
}

export function openPantry(): Pantry {
  return new Pantry();
}
