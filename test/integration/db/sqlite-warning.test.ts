// suppressSqliteExperimentalWarning (ADR-025) drops only node:sqlite's
// ExperimentalWarning. It patches process-wide state, so it runs in a child
// process on the built dist/, never in the test process.

import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const distWarning = pathToFileURL(`${repoRoot}dist/core/db/warning.js`).href;
const distDb = pathToFileURL(`${repoRoot}dist/core/db/index.js`).href;

async function stderrOf(script: string): Promise<string> {
  const { stderr } = await run(process.execPath, ['--input-type=module', '-e', script], { env: process.env });
  return stderr;
}

const afterLoad = `
  await import(${JSON.stringify(distDb)});
  process.emitWarning('sample-shop feature', 'ExperimentalWarning');
  process.emitWarning('a plain warning about SQLite usage');
  await new Promise((resolve) => setImmediate(resolve));
`;

describe('suppressSqliteExperimentalWarning', () => {
  it('drops the SQLite ExperimentalWarning and keeps every other warning', async () => {
    const stderr = await stderrOf(`
      const { suppressSqliteExperimentalWarning } = await import(${JSON.stringify(distWarning)});
      suppressSqliteExperimentalWarning();
      suppressSqliteExperimentalWarning();
      ${afterLoad}
    `);
    expect(stderr).not.toMatch(/ExperimentalWarning: SQLite/);
    expect(stderr).toContain('ExperimentalWarning: sample-shop feature');
    expect(stderr).toContain('Warning: a plain warning about SQLite usage');
  });

  it('without it, loading the db prints the SQLite warning (so the filter is what removes it)', async () => {
    const stderr = await stderrOf(afterLoad);
    expect(stderr).toMatch(/ExperimentalWarning: SQLite is an experimental feature/);
  });
});
