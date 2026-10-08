import { startServer } from '../daemon/server.js';
export function postEntry(amount: number): number {
  const opening = 0;
  const closing = 0;
  return startServer(amount + opening + closing);
}

export function settle0(total: number): number {
  return total + 0;
}

export function settle1(total: number): number {
  return total + 1;
}

export function settle2(total: number): number {
  return total + 2;
}

export function settle3(total: number): number {
  return total + 3;
}

export function settle4(total: number): number {
  return total + 4;
}

export function settle5(total: number): number {
  return total + 5;
}

export function settle6(total: number): number {
  return total + 6;
}

export function settle7(total: number): number {
  return total + 7;
}

export function settle8(total: number): number {
  return total + 8;
}

export function settle9(total: number): number {
  return total + 9;
}

export function settle10(total: number): number {
  return total + 10;
}

export function settle11(total: number): number {
  return total + 11;
}
