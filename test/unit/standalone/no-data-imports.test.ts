// standalone/no-data-imports (ADR-002, ADR-022): the standalone page mounts the
// change screen from an embedded Report, so it imports nothing from src/ui/data
// (the daemon client) or src/ui/app (the SPA shell). eslint.config.js enforces
// it for static and dynamic imports; this test lints probes for each form and
// then the real files of src/ui/standalone, which must be clean.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot, overrideConfig: tseslint.configs.disableTypeChecked });

const BOUNDARY_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);
const PROBE = 'src/ui/standalone/probe.ts';
const STANDALONE_MESSAGE = /src\/ui\/standalone must not import src\/ui\/data or src\/ui\/app/;

async function violations(filePath: string, code?: string): Promise<string[]> {
  const [result] = code === undefined ? await eslint.lintFiles([filePath]) : await eslint.lintText(code, { filePath });
  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages.filter((message) => message.ruleId !== null && BOUNDARY_RULES.has(message.ruleId)).map((m) => m.message);
}

describe('standalone/no-data-imports', () => {
  it.each([
    ["import { createApi } from '../data/api.js';\nexport const api = createApi();\n", 'a static import of data/'],
    ["import type { DataContext } from '../data/context.js';\nexport type C = DataContext;\n", 'a type import of data/'],
    ["import { mountShell } from '../app/shell.js';\nexport const shell = mountShell;\n", 'a static import of app/'],
    ["export { navigate } from '../app/router.js';\n", 're-exporting from app/'],
    ["export const load = () => import('../data/live.js');\n", 'a dynamic import of data/'],
    ["export const load = () => import('../app/main.js');\n", 'a dynamic import of app/'],
    ["import { createApi } from '../../ui/data/api.js';\nexport const api = createApi();\n", 'a path through src/ui/data'],
  ])('rejects %s (%#: %s)', async (code) => {
    const messages = await violations(PROBE, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(STANDALONE_MESSAGE);
  });

  it('accepts the shared modules and the change screen', async () => {
    const code = "import { h } from '../shared/dom.js';\nimport { mountChange } from '../screens/change/index.js';\nexport const both = [h, mountChange];\n";
    expect(await violations(PROBE, code)).toEqual([]);
  });

  it('finds no such import in the files of src/ui/standalone', async () => {
    const files = readdirSync(`${repoRoot}src/ui/standalone`).filter((name) => name.endsWith('.ts'));
    expect(files).toContain('main.ts');
    for (const name of files) expect(await violations(`src/ui/standalone/${name}`)).toEqual([]);
  });
});
