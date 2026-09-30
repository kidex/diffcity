import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedImports(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const coreFile = 'src/core/report/types.ts';

describe('src/core import boundary (eslint no-restricted-imports)', () => {
  it.each([
    "import { buildProgram } from '../../cli/program.js';\nexport const x = buildProgram;\n",
    "import type { Server } from '../../daemon/server.js';\nexport type X = Server;\n",
    "export { scene } from '../../ui/scene.js';\n",
    "import '../../daemon/index.js';\n",
    "export * from '../../ui/index.js';\n",
    "import { run } from '../../../src/cli/index.js';\nexport const x = run;\n",
  ])('forbids %s inside src/core', async (code) => {
    const messages = await restrictedImports(coreFile, code);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/src\/core must not import from src\/cli, src\/daemon or src\/ui/);
  });

  it.each([
    "import type { ParsedSymbol } from '../parse/types.js';\nexport type X = ParsedSymbol;\n",
    "import { readFile } from 'node:fs/promises';\nexport const r = readFile;\n",
  ])('allows %s inside src/core', async (code) => {
    expect(await restrictedImports(coreFile, code)).toEqual([]);
  });

  it('does not restrict src/cli', async () => {
    const code = "import type { Server } from '../daemon/server.js';\nexport type X = Server;\n";
    expect(await restrictedImports('src/cli/program.ts', code)).toEqual([]);
  });
});
