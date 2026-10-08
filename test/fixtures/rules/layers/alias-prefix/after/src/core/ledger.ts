import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { startServer } from '@orchard/legacy/server';
import { gone } from '@lost/thing';
export function postEntry(amount: number): number {
  return startServer(amount) + String(readFile).length + String(z).length + gone;
}
