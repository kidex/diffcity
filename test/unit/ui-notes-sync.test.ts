// The UI keeps its own copy of the untrusted-config note (the UI bundle cannot
// import src/core/settings, which pulls in node:fs); this keeps the two equal.

import { expect, it } from 'vitest';
import { CONFIG_NOT_TRUSTED_NOTE } from '../../src/core/settings/settings.js';
import { CONFIG_NOT_TRUSTED } from '../../src/ui/shared/notes.js';

it('the UI knows the note the daemon sends for an untrusted config', () => {
  expect(CONFIG_NOT_TRUSTED).toBe(CONFIG_NOT_TRUSTED_NOTE);
});
