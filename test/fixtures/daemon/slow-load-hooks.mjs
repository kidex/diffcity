// Module hooks for slow-load.mjs; they run on Node's hooks thread.

import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

let held = '';
let release = '';
let module = '';

export function initialize(data) {
  held = data.held;
  release = data.release;
  module = data.module;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(`/${module}`)) {
    writeFileSync(held, '');
    while (!existsSync(release)) await sleep(10);
  }
  return nextLoad(url, context);
}
