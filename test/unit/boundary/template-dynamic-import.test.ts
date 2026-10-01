// Dynamic import() with a template-literal specifier across the src/ui and
// src/daemon boundaries (ADR-022). The boundary selectors in eslint.config.js
// match `ImportExpression[source.value=...]`, and a TemplateLiteral has no
// `value`, so these imports currently pass lint.
//
// Each case is `it.fails`: it documents the gap and turns red once eslint.config.js
// rejects the import, at which point `.fails` must be dropped.

import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot, overrideConfig: tseslint.configs.disableTypeChecked });

const BOUNDARY_RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  const messages = result?.messages ?? [];
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages.filter((message) => message.ruleId !== null && BOUNDARY_RULES.has(message.ruleId)).map((m) => m.message);
}

const uiApp = 'src/ui/app/main.ts';
const change = 'src/ui/screens/change/mount.ts';
const daemon = 'src/daemon/api/repos.ts';

describe('boundary/template-dynamic-import', () => {
  it('parses template-literal imports without a fatal error (guards the cases below)', async () => {
    await violations(uiApp, 'export const load = () => import(`../shared/dom.js`);\n');
  });

  it.fails('rejects a template-literal import() of src/core from src/ui', async () => {
    const messages = await violations(uiApp, 'export const load = () => import(`../../core/report/index.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui imports from src\/core only with `import type`/);
  });

  it.fails('rejects an interpolated template import() of src/core from src/ui', async () => {
    const code = "const name = 'index';\nexport const load = () => import(`../../core/report/${name}.js`);\n";
    const messages = await violations(uiApp, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui imports from src\/core only with `import type`/);
  });

  it.fails('rejects a template-literal import() of src/ui/data from the change screen', async () => {
    const messages = await violations(change, 'export const load = () => import(`../../data/api.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui\/screens\/change must not import src\/ui\/data/);
  });

  it.fails('rejects a template-literal import() of src/cli from src/daemon', async () => {
    const messages = await violations(daemon, 'export const load = () => import(`../../cli/track.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/daemon must not import from src\/cli or src\/ui/);
  });
});
