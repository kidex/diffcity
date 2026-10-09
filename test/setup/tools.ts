// vitest setupFiles entry (ADR-032, tool/no-real-tools-in-tests): before every
// test file, puts the gh, npm and claude sentinels first on PATH and confines
// the tool runner to the temporary directory (test/helpers/tool-sentinel.ts).

import { afterAll } from 'vitest';
import { installSentinels, removeSentinels } from '../helpers/tool-sentinel.js';

const sentinels = installSentinels();
// Without the global setup (a single file run some other way) this file made its own.
if (sentinels.created) {
  afterAll(() => {
    removeSentinels(sentinels.dir);
  });
}
