// Module hooks for import-recorder.mjs; they run on Node's hooks thread.

import { appendFileSync } from 'node:fs';

let log = '';

export function initialize(data) {
  log = data.log;
}

export async function load(url, context, nextLoad) {
  appendFileSync(log, `${url}\n`);
  return nextLoad(url, context);
}
