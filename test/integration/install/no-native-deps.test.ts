// install/no-native-deps (ADR-025): no production dependency, direct or
// transitive, needs a build step at install time, so `npm i -g diffcity` and
// `npm ci` need neither Python nor a compiler.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

interface PackageJson {
  name?: string;
  gypfile?: boolean;
  scripts?: Record<string, string>;
}

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** Why a package would run something at install time; empty when it would not. */
function installSteps(dir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  const steps = INSTALL_SCRIPTS.filter((script) => pkg.scripts?.[script] !== undefined).map((script) => `scripts.${script}`);
  if (pkg.gypfile === true) steps.push('gypfile');
  // npm runs `node-gyp rebuild` for a binding.gyp unless an install script overrides it.
  if (existsSync(join(dir, 'binding.gyp'))) steps.push('binding.gyp');
  return steps;
}

describe('install', () => {
  it('install/no-native-deps: no production dependency has an install script or a gyp build', async () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const { stdout } = await run(npm, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: repoRoot });
    const dirs = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== repoRoot);

    expect(dirs.some((dir) => dir.endsWith(join('node_modules', 'commander')))).toBe(true);
    const offenders = dirs.flatMap((dir) => installSteps(dir).map((step) => `${dir.slice(repoRoot.length + 1)}: ${step}`));
    expect(offenders).toEqual([]);
  });

  it('install/no-native-deps: better-sqlite3 is gone from the dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('better-sqlite3');
  });
});
