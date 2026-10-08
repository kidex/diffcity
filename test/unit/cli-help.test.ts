import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

const SPEC_COMMANDS = ['start', 'stop', 'up', 'trust', 'shell-init', 'track', 'scan', 'diff', 'import', 'setup-claude', 'export', 'status', 'audit'];

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

  it('lists start and stop first, each with a one-line description', () => {
    const commands = buildProgram().commands;
    expect(commands.slice(0, 2).map((c) => c.name())).toEqual(['start', 'stop']);
    for (const command of commands.slice(0, 2)) {
      expect(command.description()).toMatch(/^[^\n]{10,80}$/);
    }
    const listed = [...helpText().matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]).filter((n) => n !== undefined && !n.startsWith('-'));
    expect(listed.slice(0, 2)).toEqual(['start', 'stop']);
  });

  it('gives start the --port and --no-open flags of up', () => {
    const program = buildProgram();
    const flags = (name: string) => program.commands.find((c) => c.name() === name)?.options.map((o) => o.long);
    expect(flags('start')).toEqual(expect.arrayContaining(['--port', '--no-open']));
  });

  it('exposes the flags added by ADR-001', () => {
    const program = buildProgram();
    const flags = (name: string) => program.commands.find((c) => c.name() === name)?.options.map((o) => o.long);
    expect(flags('track')).toContain('--agent');
    expect(flags('import')).toContain('--open');
  });
});
