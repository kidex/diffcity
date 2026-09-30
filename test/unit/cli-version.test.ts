import { readFileSync } from 'node:fs';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { readVersion } from '../../src/cli/version.js';

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  const program = buildProgram({ stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  program.exitOverride();
  try {
    program.parse(['node', 'diffcity', ...args]);
  } catch (err) {
    // commander throws on --version/--help when exitOverride is set; output is already captured
    if (!(err instanceof CommanderError)) throw err;
    exitCode = err.exitCode;
  }
  return { stdout, stderr, exitCode };
}

describe('diffcity --version', () => {
  it('prints the package.json version for --version', () => {
    expect(run(['--version'])).toEqual({ stdout: `${packageVersion()}\n`, stderr: '', exitCode: 0 });
  });

  it('prints the package.json version for -V', () => {
    expect(run(['-V'])).toEqual({ stdout: `${packageVersion()}\n`, stderr: '', exitCode: 0 });
  });

  it('lists -V, --version in --help', () => {
    expect(run(['--help']).stdout).toMatch(/-V, --version/);
  });

  it('readVersion returns a semver-shaped string', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  });
});
