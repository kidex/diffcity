// Dynamic import() with a template-literal specifier across the src/ui and
// src/daemon boundaries (ADR-022). The boundary selectors in eslint.config.js
// match `ImportExpression[source.value=...]`, and a TemplateLiteral has no
// `value`, so eslint.config.js rejects every non-literal import() in these
// layers (DC-38).

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

  it('rejects a template-literal import() of src/core from src/ui', async () => {
    const messages = await violations(uiApp, 'export const load = () => import(`../../core/report/index.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui imports from src\/core only with `import type`/);
  });

  it('rejects an interpolated template import() of src/core from src/ui', async () => {
    const code = "const name = 'index';\nexport const load = () => import(`../../core/report/${name}.js`);\n";
    const messages = await violations(uiApp, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui imports from src\/core only with `import type`/);
  });

  it('rejects a template-literal import() of src/ui/data from the change screen', async () => {
    const messages = await violations(change, 'export const load = () => import(`../../data/api.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/ui\/screens\/change must not import src\/ui\/data/);
  });

  it('rejects a template-literal import() of src/cli from src/daemon', async () => {
    const messages = await violations(daemon, 'export const load = () => import(`../../cli/track.js`);\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/daemon must not import from src\/cli or src\/ui/);
  });

  it('rejects an import() with a computed specifier in src/ui', async () => {
    const code = "const path = '../shared/dom.js';\nexport const load = () => import(path);\n";
    const messages = await violations(uiApp, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/needs a string literal path/);
  });
});

describe('boundary/core-dynamic-import', () => {
  const core = 'src/core/report/build.ts';
  const CORE = /src\/core must not import from src\/cli, src\/daemon or src\/ui/;

  it.each([
    "export const load = () => import('../../daemon/collector/pool.js');\n",
    'export const load = () => import(`../../cli/track.js`);\n',
    "const name = 'main';\nexport const load = () => import(`../../ui/app/${name}.js`);\n",
    "const url = 'file:///work/sample-shop/diffcity.config.js';\nexport const load = () => import(url);\n",
  ])('rejects %s', async (code) => {
    const messages = await violations(core, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(CORE);
  });

  it('allows a string-literal import() inside src/core', async () => {
    expect(await violations(core, "export const load = () => import('../parse/grammars.js');\n")).toEqual([]);
  });
});
