// `diffcity shell-init [zsh|bash|fish]` (SPEC.md section 3, 3a C1, ADR-016):
// the printed scripts, quoting, and the unknown-shell error. The scripts are
// run in real shells by test/integration/shell/hook.test.ts.
// Snapshots use placeholder paths, never the paths of the machine running them.

import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/program.js';
import { quoteFish, quotePosix, runShellInit, shellInitScript, SHELLS } from '../../../src/cli/shell-init.js';

const PLACEHOLDER = { node: '/placeholder/bin/node', cli: '/placeholder/lib/diffcity/dist/cli/index.js' };

function run(shell: string | undefined): { code: number; stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' };
  const code = runShellInit(shell, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    command: PLACEHOLDER,
  });
  return { code, ...out };
}

describe('shell-init scripts', () => {
  it.each(SHELLS)('%s matches its snapshot (placeholder paths)', async (shell) => {
    await expect(shellInitScript(shell, PLACEHOLDER)).toMatchFileSnapshot(`../../fixtures/shell/hook.${shell}`);
  });

  it('defaults to zsh', () => {
    expect(run(undefined)).toEqual({ code: 0, stdout: shellInitScript('zsh', PLACEHOLDER), stderr: '' });
  });

  it('cli/shell-init-unknown-shell: exit 1 with the supported shells', () => {
    expect(run('tcsh')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'diffcity shell-init: unsupported shell: tcsh (supported: zsh, bash, fish)\n',
    });
  });

  it('defaults to the running node and the CLI script next to this module', () => {
    const out = { stdout: '' };
    expect(runShellInit('bash', { io: { stdout: (text) => (out.stdout += text), stderr: () => undefined } })).toBe(0);
    expect(out.stdout).toContain(quotePosix(process.execPath));
    expect(out.stdout).toMatch(/\/src\/cli\/index\.js' track /);
  });

  it.each(SHELLS)('%s: honours DIFFCITY_DISABLE_HOOK, runs in the background and once at start', (shell) => {
    const script = shellInitScript(shell, PLACEHOLDER);
    expect(script).toContain('DIFFCITY_DISABLE_HOOK');
    expect(script).toContain('</dev/null >/dev/null 2>&1');
    // The last line runs the hook for the shell's initial directory.
    expect(script.trimEnd().split('\n').at(-1)).toMatch(/^__diffcity_\w+$/);
  });

  it('the commands hook in as ADR-016 says', () => {
    expect(shellInitScript('zsh', PLACEHOLDER)).toContain('add-zsh-hook chpwd __diffcity_chpwd');
    expect(shellInitScript('zsh', PLACEHOLDER)).toMatch(/&!\n/);
    expect(shellInitScript('bash', PLACEHOLDER)).toContain('PROMPT_COMMAND+=(__diffcity_prompt)');
    expect(shellInitScript('bash', PLACEHOLDER)).toMatch(/\( .* & \)\n/);
    expect(shellInitScript('fish', PLACEHOLDER)).toContain('function __diffcity_pwd --on-variable PWD');
    expect(shellInitScript('fish', PLACEHOLDER)).toMatch(/&\n\s+disown \$last_pid/);
  });

  it('the shell-init command is wired into the program', () => {
    const command = buildProgram().commands.find((c) => c.name() === 'shell-init');
    expect(command?.registeredArguments.map((argument) => argument.defaultValue as unknown)).toEqual(['zsh']);
  });
});

describe('quoting', () => {
  it.each([
    ['/plain/path', `'/plain/path'`],
    ['/with space/node', `'/with space/node'`],
    [`/it's/node`, `'/it'\\''s/node'`],
    ['/"double"/$HOME/`x`/\\', `'/"double"/$HOME/\`x\`/\\'`],
  ])('posix %s', (value, quoted) => {
    expect(quotePosix(value)).toBe(quoted);
  });

  it.each([
    ['/plain/path', `'/plain/path'`],
    [`/it's/node`, `'/it\\'s/node'`],
    ['/back\\slash/$HOME', `'/back\\\\slash/$HOME'`],
  ])('fish %s', (value, quoted) => {
    expect(quoteFish(value)).toBe(quoted);
  });
});
