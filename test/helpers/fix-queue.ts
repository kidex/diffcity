// Reading the fix queue back in tests (ADR-036, DC-112): the directory
// `<working tree>/.diffcity/fix-queue/` with one `<32 hex>.json` item per file.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FixQueueItem } from '../../src/core/fix-queue/index.js';

/** The queue directory of the working tree at `root`. */
export const fixQueueDir = (root: string): string => join(root, '.diffcity', 'fix-queue');

const ITEM_NAME = /^[0-9a-f]{32}\.json$/;

/** The item file names of the queue directory at `dir`; empty when it does not exist. */
function itemNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => ITEM_NAME.test(name)) : [];
}

/** The queued items of the working tree at `root` (or of a taken directory with `dir`), sorted by key. */
export function readFixQueue(root: string, dir: string = fixQueueDir(root)): FixQueueItem[] {
  return itemNames(dir)
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as FixQueueItem)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** True when the working tree at `root` has at least one queued item. */
export function hasFixQueue(root: string): boolean {
  return itemNames(fixQueueDir(root)).length > 0;
}

/** The total size of the queued item files, in bytes. */
export function fixQueueBytes(root: string): number {
  const dir = fixQueueDir(root);
  return itemNames(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}
