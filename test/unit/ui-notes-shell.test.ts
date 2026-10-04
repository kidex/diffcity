// ui/repo-notes shell quoting (DC-61): the copied `diffcity trust <path>` command
// must hand the shell exactly the original path, whatever characters it holds.

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CONFIG_NOT_TRUSTED_NOTE } from '../../src/core/settings/settings.js';
import { noteCopy } from '../../src/ui/shared/notes.js';

describe('trust command quoting', () => {
  const paths = [
    '/work/sample-shop',
    '/work/my shop',
    `/work/it's`,
    '/work/$HOME/`id`',
    '/work/a space \'q\' $x `bt` "dq" \\ end',
    '/work/semi;colon&amp|pipe',
    `/work/'`,
    '/work/new\nline',
  ];
  for (const path of paths) {
    it(`a POSIX shell parses ${JSON.stringify(path)} back to the original`, () => {
      const command = noteCopy(CONFIG_NOT_TRUSTED_NOTE, path).command ?? '';
      expect(command.startsWith('diffcity trust ')).toBe(true);
      const args = command.slice('diffcity trust '.length);
      expect(execFileSync('sh', ['-c', `printf %s ${args}`], { encoding: 'utf8' })).toBe(path);
    });
  }
});
