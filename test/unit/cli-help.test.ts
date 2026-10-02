import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

const SPEC_COMMANDS = ['up', 'trust', 'shell-init', 'track', 'scan', 'diff', 'import', 'export', 'status', 'audit'];

function helpText(): string {
  let out = '';
  const program = buildProgram({ stdout: (t) => (out += t), stderr: (t) => (out += t) });
  program.exitOverride();
  try {
    program.parse(['node', 'diffcity', '--help']);
  } catch {
    // commander throws on --help when exitOverride is set; the text is already captured
  }
  return out;
}

describe('diffcity --help', () => {
  it('lists every command from SPEC.md section 3', () => {
    const help = helpText();
    for (const name of SPEC_COMMANDS) {
      expect(help).toMatch(new RegExp(`^\\s+${name}\\b`, 'm'));
    }
  });

  it('registers exactly the SPEC.md commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names.sort()).toEqual([...SPEC_COMMANDS].sort());
  });

  it('lists trust right after the daemon command, with --list and --remove (ADR-030)', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names.indexOf('trust')).toBe(names.indexOf('up') + 1);
    expect(program.commands.find((c) => c.name() === 'trust')?.options.map((o) => o.long)).toEqual(['--list', '--remove']);
  });

  it('exposes the flags added by ADR-001', () => {
    const program = buildProgram();
    const flags = (name: string) => program.commands.find((c) => c.name() === name)?.options.map((o) => o.long);
    expect(flags('track')).toContain('--agent');
    expect(flags('import')).toContain('--open');
  });
});
