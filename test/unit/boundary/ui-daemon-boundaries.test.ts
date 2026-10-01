// Import boundaries for src/ui and src/daemon (SPEC.md section 10, ADR-002,
// ADR-022), enforced by eslint.config.js. The files linted here do not exist on
// disk, so the type-checked rules are switched off: the boundary rules only need
// the syntax tree.

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
  // A parsing error would hide the rules and make a "not flagged" assertion vacuous.
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages.filter((message) => message.ruleId !== null && BOUNDARY_RULES.has(message.ruleId)).map((m) => m.message);
}

const uiApp = 'src/ui/app/main.ts';
const fleet = 'src/ui/screens/fleet/render.ts';
const change = 'src/ui/screens/change/mount.ts';
const changeNested = 'src/ui/screens/change/panels/symbols.ts';
const daemon = 'src/daemon/api/repos.ts';

const TYPE_ONLY = /src\/ui imports from src\/core only with `import type`/;
const NO_CLI_DAEMON = /src\/ui must not import from src\/cli or src\/daemon/;
const NO_DATA = /src\/ui\/screens\/change must not import src\/ui\/data/;
const DAEMON_NO_CLI_UI = /src\/daemon must not import from src\/cli or src\/ui/;

describe('boundary/ui-type-only-core-imports', () => {
  it.each([
    [uiApp, "import { buildReport } from '../../core/report/index.js';\nexport const b = buildReport;\n"],
    [uiApp, "import { type Report } from '../../core/report/types.js';\nexport type R = Report;\n"],
    [uiApp, "import { resolveHome, type HomePaths } from '../../core/home.js';\nexport type H = HomePaths;\nexport const r = resolveHome;\n"],
    [uiApp, "import '../../core/home.js';\n"],
    [uiApp, "export { homePaths } from '../../core/home.js';\n"],
    [uiApp, "export * from '../../core/model/types.js';\n"],
    [uiApp, "export const load = () => import('../../core/report/index.js');\n"],
    [fleet, "import { resolveHome } from '../../../../src/core/home.js';\nexport const r = resolveHome;\n"],
    [change, "import { buildReport } from '../../../core/report/index.js';\nexport const b = buildReport;\n"],
  ])('forbids a value import from src/core in %s: %s', async (file, code) => {
    const messages = await violations(file, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(TYPE_ONLY);
  });

  it.each([
    [uiApp, "import type { Report } from '../../core/report/types.js';\nexport type R = Report;\n"],
    [uiApp, "import type { RepoSummary } from '../../core/model/types.js';\nexport type S = RepoSummary;\n"],
    [uiApp, "export type { ChangeSummary } from '../../core/model/types.js';\n"],
    [uiApp, "export type * from '../../core/model/types.js';\n"],
    [uiApp, "export type R = import('../../core/report/types.js').Report;\n"],
    [change, "import type { Report } from '../../../core/report/types.js';\nexport type R = Report;\n"],
  ])('allows a type-only import from src/core in %s: %s', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });

  it.each([
    [uiApp, "import type { Server } from '../../daemon/server.js';\nexport type S = Server;\n"],
    [uiApp, "import { buildProgram } from '../../cli/program.js';\nexport const p = buildProgram;\n"],
    [fleet, "export * from '../../../daemon/sse.js';\n"],
    [fleet, "export const load = () => import('../../../cli/track.js');\n"],
    [change, "import type { CliIo } from '../../../../src/cli/program.js';\nexport type C = CliIo;\n"],
  ])('forbids any import from src/cli or src/daemon in %s: %s', async (file, code) => {
    const messages = await violations(file, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(NO_CLI_DAEMON);
  });

  it.each([
    [uiApp, "import { h } from '../shared/dom.js';\nexport const x = h;\n"],
    [uiApp, "import { api } from '../data/api.js';\nexport const x = api;\n"],
    [uiApp, "import { scorecard } from './coreless/score.js';\nexport const x = scorecard;\n"],
    [uiApp, "import { tile } from '../daemonic/tile.js';\nexport const x = tile;\n"],
    [uiApp, "import { icon } from '../clip/icon.js';\nexport const x = icon;\n"],
    [uiApp, "export const load = () => import('../screens/fleet/render.js');\n"],
  ])('does not flag UI-internal or look-alike imports in %s: %s', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });
});

describe('boundary/ui-change-screen-no-data', () => {
  it.each([
    [change, "import { fetchReport } from '../../data/api.js';\nexport const f = fetchReport;\n"],
    [change, "import type { LiveClient } from '../../data/live.js';\nexport type L = LiveClient;\n"],
    [change, "export * from '../../data/index.js';\n"],
    [change, "export const load = () => import('../../data/api.js');\n"],
    [changeNested, "import { fetchReport } from '../../../data/api.js';\nexport const f = fetchReport;\n"],
    [changeNested, "import { fetchReport } from '../../../../../src/ui/data/api.js';\nexport const f = fetchReport;\n"],
  ])('forbids src/ui/data in %s: %s', async (file, code) => {
    const messages = await violations(file, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(NO_DATA);
  });

  it('still enforces the src/ui rules inside the change screen', async () => {
    const code =
      "import { buildReport } from '../../../core/report/index.js';\n" +
      "import type { Server } from '../../../daemon/server.js';\n" +
      'export type S = Server;\nexport const b = buildReport;\n';
    const messages = await violations(change, code);
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => TYPE_ONLY.test(message))).toBe(true);
    expect(messages.some((message) => NO_CLI_DAEMON.test(message))).toBe(true);
  });

  it.each([
    [change, "import { h } from '../../shared/dom.js';\nexport const x = h;\n"],
    [change, "import { legend } from '../../shared/database-legend.js';\nexport const x = legend;\n"],
    [fleet, "import { fetchRepos } from '../../data/api.js';\nexport const f = fetchRepos;\n"],
  ])('allows %s: %s', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });
});

describe('boundary/daemon-no-cli-ui', () => {
  it.each([
    "import { buildProgram } from '../../cli/program.js';\nexport const p = buildProgram;\n",
    "import type { CliIo } from '../../cli/program.js';\nexport type C = CliIo;\n",
    "import { mountChange } from '../../ui/screens/change/mount.js';\nexport const m = mountChange;\n",
    "export * from '../../ui/index.js';\n",
    "import '../../../src/ui/app/main.js';\n",
    "export const load = () => import('../../cli/track.js');\n",
  ])('forbids %s', async (code) => {
    const messages = await violations(daemon, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(DAEMON_NO_CLI_UI);
  });

  it.each([
    "import { buildReport } from '../../core/report/index.js';\nexport const b = buildReport;\n",
    "import { homePaths } from '../../core/home.js';\nexport const p = homePaths;\n",
    "import { hub } from '../sse/hub.js';\nexport const h = hub;\n",
    "import { guide } from '../guide/index.js';\nexport const g = guide;\n",
    "import { client } from '../clients/index.js';\nexport const c = client;\n",
  ])('allows %s', async (code) => {
    expect(await violations(daemon, code)).toEqual([]);
  });

  it('does not restrict src/cli importing from src/daemon', async () => {
    const code = "import type { Server } from '../daemon/server.js';\nexport type S = Server;\n";
    expect(await violations('src/cli/up.ts', code)).toEqual([]);
  });
});
