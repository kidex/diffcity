// Edge cases for the src/core import boundary. Code is linted as if it lived in an
// existing file, because the type-aware parser only accepts files the project knows.

import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function restricted(filePath: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  const messages = result?.messages ?? [];
  // A parsing error would hide the rule and make a "not flagged" assertion vacuous.
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
}

const report = 'src/core/report/types.ts';
const parse = 'src/core/parse/types.ts';

describe('src/core import boundary, edge cases', () => {
  it.each([
    [parse, "import { x } from '../../cli';\nexport const y = x;\n"],
    [parse, "import { x } from '../../daemon';\nexport const y = x;\n"],
    [parse, "import { x } from '../../ui/scene/city.js';\nexport const y = x;\n"],
    [report, "import type { X } from '../../daemon/sse.js';\nexport type Y = X;\n"],
    [report, "export { watch } from '../../daemon/watcher/index.js';\n"],
    [report, "import { x } from '../../../src/ui';\nexport const y = x;\n"],
  ])('forbids in %s: %s', async (file, code) => {
    expect(await restricted(file, code)).toBe(1);
  });

  it.each([
    [report, "import { x } from './uikit.js';\nexport const y = x;\n"],
    [report, "import { x } from '../daemonless/run.js';\nexport const y = x;\n"],
    [report, "import { x } from '../clique.js';\nexport const y = x;\n"],
  ])('does not flag look-alike names in %s: %s', async (file, code) => {
    expect(await restricted(file, code)).toBe(0);
  });

  it('lets src/cli import from src/core', async () => {
    const code = "import type { Report } from '../core/report/types.js';\nexport type R = Report;\n";
    expect(await restricted('src/cli/program.ts', code)).toBe(0);
  });

  it('the real src/core files are clean under the rule', async () => {
    const results = await eslint.lintFiles(['src/core/**/*.ts']);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const result of results) expect(result.errorCount).toBe(0);
  });
});
