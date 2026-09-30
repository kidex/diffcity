import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliEntry = join(repoRoot, 'dist', 'cli', 'index.js');

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

let workDir: string;

function runBuilt(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliEntry, ...args], { cwd: workDir, encoding: 'utf8' });
}

describe('diffcity --version from built dist/', () => {
  beforeAll(() => {
    const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    if (build.status !== 0) {
      throw new Error(`npm run build failed (${String(build.status)}):\n${build.stdout}\n${build.stderr}`);
    }
    workDir = mkdtempSync(join(tmpdir(), 'diffcity-version-'));
  }, 120_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('prints exactly the package.json version for --version, from an unrelated cwd', () => {
    const result = runBuilt(['--version']);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(`${packageVersion()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('prints exactly the package.json version for -V, from an unrelated cwd', () => {
    const result = runBuilt(['-V']);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(`${packageVersion()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('lists -V, --version in --help of the built CLI', () => {
    const result = runBuilt(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/-V, --version/);
  });
});
