// suppressSqliteExperimentalWarning (ADR-025) drops only node:sqlite's
// ExperimentalWarning. It patches process-wide state, so it runs in a child
// process on the built dist/, never in the test process.

import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { tempHome } from '../../helpers/config.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const distWarning = pathToFileURL(`${repoRoot}dist/core/db/warning.js`).href;
const distDb = pathToFileURL(`${repoRoot}dist/core/db/index.js`).href;

async function stderrOf(script: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stderr } = await run(process.execPath, ['--input-type=module', '-e', script], { env });
  return stderr;
}

const afterLoad = `
  await import(${JSON.stringify(distDb)});
  process.emitWarning('sample-shop feature', 'ExperimentalWarning');
  process.emitWarning('a plain warning about SQLite usage');
  await new Promise((resolve) => setImmediate(resolve));
`;

// Whether this runtime warns when node:sqlite loads: Node 22 does, Node 24
// does not. Probed in a child process rather than read from the version.
const SQLITE_WARNING = /ExperimentalWarning: SQLite is an experimental feature/;
const runtimeWarns = SQLITE_WARNING.test(
  await stderrOf(`await import('node:sqlite'); await new Promise((resolve) => setImmediate(resolve));`),
);

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

  it.runIf(runtimeWarns)('without it, loading the db prints the SQLite warning (so the filter is what removes it)', async () => {
    const stderr = await stderrOf(afterLoad);
    expect(stderr).toMatch(SQLITE_WARNING);
  });

  it.skipIf(runtimeWarns)('on a runtime that emits no SQLite warning, loading the db prints none either way', async () => {
    const stderr = await stderrOf(afterLoad);
    expect(stderr).not.toMatch(/ExperimentalWarning: SQLite/);
    expect(stderr).toContain('ExperimentalWarning: sample-shop feature');
    expect(stderr).toContain('Warning: a plain warning about SQLite usage');
  });

  it('daemon order: suppress, then dynamic import and a real open/write/read prints nothing on stderr', async () => {
    const temp = await tempHome();
    try {
      const dbPath = `${temp.home}/diffcity.db`;
      const stderr = await stderrOf(
        `
        const { mkdirSync } = await import('node:fs');
        const { suppressSqliteExperimentalWarning } = await import(${JSON.stringify(distWarning)});
        suppressSqliteExperimentalWarning();
        const { openDb } = await import(${JSON.stringify(distDb)});
        mkdirSync(${JSON.stringify(temp.home)}, { recursive: true });
        const db = openDb(${JSON.stringify(dbPath)});
        if (db.pragmas().journalMode !== 'wal') throw new Error('not wal');
        db.transaction(() => db.purgeArchived('2026-01-01T00:00:00.000Z'));
        db.close();
        const again = openDb(${JSON.stringify(dbPath)});
        again.close();
        await new Promise((resolve) => setImmediate(resolve));
      `,
        temp.env,
      );
      expect(stderr).toBe('');
    } finally {
      await temp.cleanup();
    }
  });
});
