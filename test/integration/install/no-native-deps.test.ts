// install/no-native-deps (ADR-025): no production dependency, direct or
// transitive, needs a build step at install time, so `npm i -g diffcity` and
// `npm ci` need neither Python nor a compiler.
//
// The production tree is read from package-lock.json rather than `npm ls`:
// tests never start a real npm (ADR-032, tool/no-real-tools-in-tests).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

interface LockEntry {
  dev?: boolean;
  hasInstallScript?: boolean;
}

/** Every production package of the lockfile that is installed, by its directory under the repo root. */
function productionPackages(): { dir: string; entry: LockEntry }[] {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path !== '' && entry.dev !== true)
    .map(([path, entry]) => ({ dir: join(repoRoot, path), entry }))
    // An optional package for another platform is in the lockfile but not installed.
    .filter(({ dir }) => existsSync(join(dir, 'package.json')));
}

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
  it('install/no-native-deps: no production dependency has an install script or a gyp build', () => {
    const packages = productionPackages();
    const dirs = packages.map(({ dir }) => dir);

    expect(dirs.some((dir) => dir.endsWith(join('node_modules', 'commander')))).toBe(true);
    const offenders = packages.flatMap(({ dir, entry }) =>
      [...installSteps(dir), ...(entry.hasInstallScript === true ? ['hasInstallScript'] : [])].map((step) => `${dir.slice(repoRoot.length + 1)}: ${step}`),
    );
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
