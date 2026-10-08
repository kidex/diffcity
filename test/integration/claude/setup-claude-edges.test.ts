// Edge cases of `diffcity setup-claude` (ADR-037) found while testing DC-107:
// a settings.json with comments, one that is a symbolic link, a read-only
// configuration directory, and Stop hooks with other matchers. CLAUDE_CONFIG_DIR
// always points into os.tmpdir(), never at the real ~/.claude.

import { chmod, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetupClaude, type SetupClaudeOptions } from '../../../src/cli/setup-claude.js';
import { CLAUDE_CONFIG_DIR_ENV } from '../../../src/core/claude/config-dir.js';
import { tempHome, type TempHome } from '../../helpers/config.js';

let temp: TempHome;
let claude: string;
let nodePath: string;
let cliEntry: string;
let emptyPath: string;

beforeEach(async () => {
  temp = await tempHome();
  Reflect.deleteProperty(temp.env, 'npm_command');
  const root = await realpath(temp.root);
  claude = join(root, 'claude-config');
  nodePath = join(root, 'sample-node', 'bin', 'node');
  cliEntry = join(root, 'sample-install', 'dist', 'cli', 'index.js');
  await mkdir(join(root, 'sample-node', 'bin'), { recursive: true });
  await mkdir(join(root, 'sample-install', 'dist', 'cli'), { recursive: true });
  await writeFile(nodePath, '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(cliEntry, '#!/usr/bin/env node\n', { mode: 0o755 });
  emptyPath = join(root, 'empty-bin');
  await mkdir(emptyPath);
});
afterEach(async () => {
  await chmod(claude, 0o755).catch(() => undefined);
  await temp.cleanup();
});

const HOOK = (): string => `"${nodePath}" "${cliEntry}" track --agent`;
const settingsPath = (): string => join(claude, 'settings.json');

async function setup(options: SetupClaudeOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = { stdout: '', stderr: '' };
  const code = await runSetupClaude(options, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: emptyPath },
    cwd: temp.userHome,
    nodePath,
    cliEntry,
  });
  return { code, ...out };
}

/** Every file under `dir` with its content (a link as `-> target`). */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) files[relative(dir, path)] = `-> ${await readlink(path)}`;
      else files[relative(dir, path)] = await readFile(path, 'utf8');
    }
  };
  await walk(dir);
  return files;
}

describe('setup-claude edge cases (DC-107)', () => {
  it('setup/unparsable-settings-refused (comments): a settings.json with comments and a trailing comma is refused on install and on --remove, untouched', async () => {
    const commented = '{\n  // the model used by this sample\n  "model": "sample-model",\n}\n';
    await mkdir(claude, { recursive: true });
    await writeFile(settingsPath(), commented);
    for (const options of [{}, { remove: true }, { dryRun: true }]) {
      const result = await setup(options);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`refused: ${settingsPath()} is not valid JSON`);
      expect(await snapshot(claude)).toEqual({ 'settings.json': commented });
    }
  });

  it('setup/settings-symlink: a settings.json that is a link is written at its target and the link stays, on install and on --remove', async () => {
    const dotfiles = join(temp.root, 'sample-dotfiles');
    await mkdir(dotfiles);
    const target = join(await realpath(dotfiles), 'claude-settings.json');
    const original = '{"model":"sample-model"}\n';
    await writeFile(target, original);
    await mkdir(claude, { recursive: true });
    await symlink(target, settingsPath());

    expect((await setup()).code).toBe(0);
    expect(await readlink(settingsPath())).toBe(target);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      model: 'sample-model',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK() }] }] },
    });
    expect(await readFile(`${settingsPath()}.diffcity-backup`, 'utf8')).toBe(original);
    // No temporary file next to the target.
    expect(await readdir(dotfiles)).toEqual(['claude-settings.json']);

    expect((await setup({ remove: true })).code).toBe(0);
    expect(await readlink(settingsPath())).toBe(target);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ model: 'sample-model' });
  });

  it.skipIf(process.getuid?.() === 0)('setup/read-only-config-dir: exit 1 with the reason; settings.json and the directory stay as they were', async () => {
    await mkdir(join(claude, 'commands'), { recursive: true });
    await writeFile(settingsPath(), '{"model":"sample-model"}\n');
    const before = await snapshot(claude);
    await chmod(claude, 0o555);
    await chmod(join(claude, 'commands'), 0o555);
    const result = await setup();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^diffcity setup-claude: EACCES: permission denied/);
    expect(result.stderr.split('\n').filter((line) => line !== '')).toHaveLength(1);
    await chmod(join(claude, 'commands'), 0o755);
    expect(await snapshot(claude)).toEqual(before);
  });

  it('setup/keeps-existing-hooks-and-keys (matchers): Stop entries with other matchers and several hooks stay in order; install then --remove gives the original back', async () => {
    const existing = {
      model: 'sample-model',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sample-guard' }] }],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'sample-notify', timeout: 5 }, { type: 'command', command: 'sample-log' }] },
          { hooks: [{ type: 'command', command: 'sample-chime' }] },
        ],
        SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: 'sample-sub' }] }],
      },
    };
    await mkdir(claude, { recursive: true });
    await writeFile(settingsPath(), `${JSON.stringify(existing, null, 2)}\n`);

    expect((await setup()).code).toBe(0);
    const installed = JSON.parse(await readFile(settingsPath(), 'utf8')) as typeof existing;
    expect(installed).toEqual({
      ...existing,
      hooks: { ...existing.hooks, Stop: [...existing.hooks.Stop, { matcher: '', hooks: [{ type: 'command', command: HOOK() }] }] },
    });
    expect(Object.keys(installed.hooks)).toEqual(['PreToolUse', 'Stop', 'SubagentStop']);

    expect((await setup({ remove: true })).code).toBe(0);
    expect(await readFile(settingsPath(), 'utf8')).toBe(`${JSON.stringify(existing, null, 2)}\n`);
  });
});
