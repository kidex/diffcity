// Preloaded with `node --import` by tests that check which modules a command
// loads. Appends the URL of every module Node loads, one per line, to the file
// named by DIFFCITY_TEST_IMPORT_LOG.

import { register } from 'node:module';

const log = process.env.DIFFCITY_TEST_IMPORT_LOG;
if (log === undefined || log === '') {
  throw new Error('import-recorder: set DIFFCITY_TEST_IMPORT_LOG to the log file path');
}

register(new URL('./import-recorder-hooks.mjs', import.meta.url), { data: { log } });
