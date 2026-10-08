// Module hooks for slow-load.mjs; they run on Node's hooks thread.

import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

let held = '';
let release = '';

export function initialize(data) {
  held = data.held;
  release = data.release;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('/daemon/script.js')) {
    writeFileSync(held, '');
    while (!existsSync(release)) await sleep(10);
  }
  return nextLoad(url, context);
}
