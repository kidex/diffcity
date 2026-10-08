// Preloaded with `node --import` by tests that signal the daemon entry while
// it loads the daemon body (DC-119). The load of daemon/script.js is held:
// the hooks create the file DIFFCITY_TEST_LOAD_HELD names once the load has
// started, and let it finish only when the file DIFFCITY_TEST_LOAD_RELEASE
// names exists.

import { register } from 'node:module';

const held = process.env.DIFFCITY_TEST_LOAD_HELD;
const release = process.env.DIFFCITY_TEST_LOAD_RELEASE;
if (held === undefined || held === '' || release === undefined || release === '') {
  throw new Error('slow-load: set DIFFCITY_TEST_LOAD_HELD and DIFFCITY_TEST_LOAD_RELEASE');
}

register(new URL('./slow-load-hooks.mjs', import.meta.url), { data: { held, release } });
