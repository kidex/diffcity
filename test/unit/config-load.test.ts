import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE_NAME, ConfigError, loadConfig } from '../../src/core/config/index.js';

const dirs: string[] = [];
const TRUSTED = { trusted: true } as const;

async function repoWithConfig(source: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'diffcity-config-'));
  dirs.push(dir);
  if (source !== null) await writeFile(join(dir, CONFIG_FILE_NAME), source, 'utf8');
  return dir;
}

async function loadError(source: string): Promise<ConfigError> {
  const dir = await repoWithConfig(source);
  try {
    await loadConfig(dir, TRUSTED);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to fail');
}

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('loadConfig (ADR-012 config, ADR-007 tier1 shape)', () => {
  it('returns an empty config when diffcity.config.js is absent', async () => {
    expect(await loadConfig(await repoWithConfig(null), TRUSTED)).toEqual({});
  });

  it('loads base and a tier1 array', async () => {
    const dir = await repoWithConfig(`export default { base: 'trunk', tier1: ['ledger', 'vault'] };\n`);
    expect(await loadConfig(dir, TRUSTED)).toEqual({ base: 'trunk', tier1: ['ledger', 'vault'] });
  });

  it('loads a tier1 function that receives the defaults', async () => {
    const dir = await repoWithConfig(
      `export default { tier1: (defaults) => defaults.filter((t) => t !== 'schema').concat('ledger') };\n`,
    );
    const config = await loadConfig(dir, TRUSTED);
    expect(typeof config.tier1).toBe('function');
    if (typeof config.tier1 !== 'function') throw new Error('unreachable');
    expect(config.tier1(['auth', 'schema'])).toEqual(['auth', 'ledger']);
  });

  it('keeps rules as written, even invalid ones: src/core/rules reports them rule by rule (ADR-030)', async () => {
    const dir = await repoWithConfig(`export default { rules: [{ id: 'size', kind: 'file-size', maxLines: 300 }, { id: 'ci', kind: 'pipeline' }] };\n`);
    expect(await loadConfig(dir, TRUSTED)).toEqual({ rules: [{ id: 'size', kind: 'file-size', maxLines: 300 }, { id: 'ci', kind: 'pipeline' }] });
    expect(await loadConfig(await repoWithConfig(`export default { rules: 'size' };\n`), TRUSTED)).toEqual({ rules: 'size' });
  });

  it('accepts an empty default export', async () => {
    expect(await loadConfig(await repoWithConfig('export default {};\n'), TRUSTED)).toEqual({});
  });

  it('picks up an edited config on the next load', async () => {
    const dir = await repoWithConfig(`export default { base: 'trunk' };\n`);
    expect((await loadConfig(dir, TRUSTED)).base).toBe('trunk');
    await writeFile(join(dir, CONFIG_FILE_NAME), `export default { base: 'develop' };\n`, 'utf8');
    expect((await loadConfig(dir, TRUSTED)).base).toBe('develop');
  });

  describe('untrusted repo (ADR-030, DC-53)', () => {
    it('never imports the config file and gives an empty config', async () => {
      const dir = await repoWithConfig(null);
      const marker = join(dir, 'imported.marker');
      await writeFile(
        join(dir, CONFIG_FILE_NAME),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport default { base: 'trunk' };\n`,
        'utf8',
      );
      expect(await loadConfig(dir, { trusted: false })).toEqual({});
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await loadConfig(dir, TRUSTED)).toEqual({ base: 'trunk' });
      await expect(access(marker)).resolves.toBeUndefined();
    });

    it('ignores an invalid config file instead of failing', async () => {
      expect(await loadConfig(await repoWithConfig('export default {;\n'), { trusted: false })).toEqual({});
    });
  });

  describe('config-invalid-field', () => {
    it('names an unknown field', async () => {
      const error = await loadError(`export default { base: 'main', tierOne: ['x'] };\n`);
      expect(error.field).toBe('tierOne');
      expect(error.message).toContain('"tierOne"');
      expect(error.message).toContain(CONFIG_FILE_NAME);
    });

    it('names base when it is not a string', async () => {
      const error = await loadError('export default { base: 42 };\n');
      expect(error.field).toBe('base');
      expect(error.message).toContain('"base"');
    });

    it('names base when it is an empty string', async () => {
      expect((await loadError(`export default { base: '' };\n`)).field).toBe('base');
    });

    it('names tier1 when it is neither an array nor a function', async () => {
      const error = await loadError(`export default { tier1: 'auth' };\n`);
      expect(error.field).toBe('tier1');
      expect(error.message).toContain('"tier1"');
    });

    it('names tier1 when an array entry is not a string', async () => {
      expect((await loadError(`export default { tier1: ['auth', 7] };\n`)).field).toBe('tier1');
    });

    it('names tier1 when an array entry is an empty string', async () => {
      for (const token of ["''", "'   '"]) {
        const error = await loadError(`export default { tier1: ['auth', ${token}] };\n`);
        expect(error.field).toBe('tier1');
        expect(error.message).toContain('"tier1"');
      }
    });

    it('rejects a default export that is not an object', async () => {
      const error = await loadError(`export default ['auth'];\n`);
      expect(error.field).toBeUndefined();
      expect(error.message).toContain('default export');
    });

    it('rejects a module without a default export', async () => {
      expect((await loadError(`export const base = 'main';\n`)).message).toContain('default export');
    });

    it('wraps a syntax error in the config file', async () => {
      const error = await loadError('export default {;\n');
      expect(error.message).toContain(`failed to load ${CONFIG_FILE_NAME}`);
    });
  });
});
