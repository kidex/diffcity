// `diffcity setup-claude` (SPEC.md section 7, ADR-037) on temporary Claude
// Code configuration directories: CLAUDE_CONFIG_DIR always points into
// os.tmpdir(), never at the real ~/.claude.

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetupClaude, type SetupClaudeDeps, type SetupClaudeOptions } from '../../../src/cli/setup-claude.js';
import { CLAUDE_CONFIG_DIR_ENV, claudeConfigDir } from '../../../src/core/claude/config-dir.js';
import { COMMAND_MARKER, LEGACY_COMMAND_MARKER, commandFileText } from '../../../src/core/claude/command-file.js';
import { chooseCliInvocation, hookCommand, isLocalBin } from '../../../src/core/claude/hook-command.js';
import { CLAUDE_CODE_CHECKED_VERSION } from '../../../src/core/claude/setup.js';
import { homePaths } from '../../../src/core/home.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { CLI_DIST, DaemonTracker } from '../../helpers/daemon.js';
import { startFakeDaemon } from '../../helpers/fake-daemon.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { createRepo } from '../../helpers/repo.js';

isolateGitConfig();

let temp: TempHome;
/** The temporary Claude Code configuration directory. */
let claude: string;
/** A fake install: node at `<root>/sample-node/bin/node`, the CLI at `<root>/sample-install/dist/cli/index.js`. */
let nodePath: string;
let cliEntry: string;
/** A PATH with no `diffcity` on it. */
let emptyPath: string;
const daemons = new DaemonTracker();

beforeEach(async () => {
  temp = await tempHome();
  // Run under npx the suite would inherit npm_command=exec, which never gives the global form.
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
  await daemons.cleanup();
  await temp.cleanup();
});

const ABSOLUTE = (): string => `"${nodePath}" "${cliEntry}"`;
const settingsPath = (): string => join(claude, 'settings.json');
const commandPath = (): string => join(claude, 'commands', 'diffcity-review.md');
const backupPath = (): string => join(claude, 'settings.json.diffcity-backup');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function setup(options: SetupClaudeOptions = {}, deps: Partial<SetupClaudeDeps> = {}): Promise<Result> {
  const out = { stdout: '', stderr: '' };
  const code = await runSetupClaude(options, {
    io: { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: emptyPath },
    cwd: temp.userHome,
    nodePath,
    cliEntry,
    ...deps,
  });
  return { code, ...out };
}

const readOptional = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null);

/** Every file under `dir` with its content, for before/after comparisons. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) files[relative(dir, path)] = `-> ${await readlink(path)}`;
      else files[relative(dir, path)] = await readFile(path, 'utf8');
    }
  };
  await walk(dir);
  return files;
}

const existingSettings = {
  model: 'sample-model',
  permissions: { allow: ['Bash(npm run lint)'] },
  hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }] },
};

describe('setup-claude: install', () => {
  it('writes the command file and the Stop hook, and prints the files, the hook command and the Claude Code version', async () => {
    const result = await setup();
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        `created ${commandPath()}`,
        `created ${settingsPath()}`,
        `hook command: ${ABSOLUTE()} track --agent`,
        `checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`,
        '',
      ].join('\n'),
    });
    expect(await readFile(commandPath(), 'utf8')).toBe(commandFileText(ABSOLUTE()));
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${ABSOLUTE()} track --agent` }] }] },
    });
    // Nothing to back up: there was no settings.json.
    expect(await readOptional(backupPath())).toBeNull();
  });

  it('setup/merge-is-idempotent (files): a second run changes nothing and says so', async () => {
    await writeFile(join(await mkdirp(claude), 'settings.json'), JSON.stringify(existingSettings));
    expect((await setup()).code).toBe(0);
    const before = await snapshot(claude);
    const again = await setup();
    expect(again.stdout).toBe(
      [
        `unchanged ${commandPath()}`,
        `unchanged ${settingsPath()} (the Stop hook is already there)`,
        `hook command: ${ABSOLUTE()} track --agent`,
        `checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`,
        '',
      ].join('\n'),
    );
    expect(await snapshot(claude)).toEqual(before);
  });

  it('setup/keeps-existing-hooks-and-keys (files): the existing settings stay, the hook is appended', async () => {
    await writeFile(join(await mkdirp(claude), 'settings.json'), JSON.stringify(existingSettings, null, 4), { mode: 0o600 });
    const result = await setup();
    expect(result.stdout).toContain(`updated ${settingsPath()} (added the Stop hook)\n`);
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      ...existingSettings,
      hooks: { Stop: [...existingSettings.hooks.Stop, { matcher: '', hooks: [{ type: 'command', command: `${ABSOLUTE()} track --agent` }] }] },
    });
    // The file keeps its mode, and no temporary file is left behind.
    expect((await stat(settingsPath())).mode & 0o777).toBe(0o600);
    expect(Object.keys(await snapshot(claude)).sort()).toEqual(['commands/diffcity-review.md', 'settings.json', 'settings.json.diffcity-backup']);
  });

  it('setup/unparsable-settings-refused: exit 1 with the reason; neither file is written', async () => {
    const broken = '{ "model": "sample-model", }\n';
    await writeFile(join(await mkdirp(claude), 'settings.json'), broken);
    const result = await setup();
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(new RegExp(`^diffcity setup-claude: refused: ${escape(settingsPath())} is not valid JSON \\(.*\\); fix it or move it away, nothing was written\\n$`));
    expect(await snapshot(claude)).toEqual({ 'settings.json': broken });
  });

  it('setup/backup-written-once: the first change backs up the original; later changes keep that backup', async () => {
    const original = `${JSON.stringify(existingSettings, null, 2)}\n`;
    await writeFile(join(await mkdirp(claude), 'settings.json'), original);
    const first = await setup();
    expect(first.stdout.split('\n')[0]).toBe(`backed up ${settingsPath()} to ${backupPath()}`);
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    // Removing and installing again change settings.json twice more; the backup stays the original.
    const removed = await setup({ remove: true });
    expect(removed.stdout).not.toContain('backed up');
    expect((await setup()).stdout).not.toContain('backed up');
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    // A run that changes nothing writes no backup either.
    await rm(backupPath());
    expect((await setup()).stdout).not.toContain('backed up');
    expect(await readOptional(backupPath())).toBeNull();
  });

  it('setup/reinstall-replaces-recorded-hook: setup from another install replaces the hook its command file recorded', async () => {
    const original = JSON.stringify(existingSettings);
    await writeFile(join(await mkdirp(claude), 'settings.json'), original);
    expect((await setup()).code).toBe(0);
    // diffcity is now installed globally: the next run uses `diffcity`.
    const bin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(bin, 'diffcity'));
    const env = { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: bin };
    const result = await setup({}, { env });
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        `updated ${commandPath()}`,
        `updated ${settingsPath()} (replaced the Stop hook)`,
        'hook command: diffcity track --agent',
        `checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`,
        '',
      ].join('\n'),
    });
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      ...existingSettings,
      hooks: { Stop: [...existingSettings.hooks.Stop, { matcher: '', hooks: [{ type: 'command', command: 'diffcity track --agent' }] }] },
    });
    expect(await readFile(commandPath(), 'utf8')).toBe(commandFileText('diffcity'));
    // The backup is still the settings from before the first run.
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    // Running again with the same install changes nothing.
    expect((await setup({}, { env })).stdout).toContain(`unchanged ${settingsPath()} (the Stop hook is already there)\n`);
  });

  it('setup/reinstall-replaces-recorded-hook (both present): the old hook goes, the new one already there stays once', async () => {
    expect((await setup()).code).toBe(0);
    const old = `${ABSOLUTE()} track --agent`;
    await writeFile(settingsPath(), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: old }] }, { matcher: '', hooks: [{ type: 'command', command: 'diffcity track --agent' }] }] } }));
    const bin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(bin, 'diffcity'));
    const result = await setup({}, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: bin } });
    expect(result.stdout).toContain(`updated ${settingsPath()} (replaced the Stop hook)\n`);
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'diffcity track --agent' }] }] } });
  });

  it('setup/command-file-marker-overwrite: a file with the marker after its frontmatter is overwritten', async () => {
    const older = `---\ndescription: an older diffcity review\n---\n${COMMAND_MARKER}\nRun \`npx diffcity diff --json\`.\n`;
    await mkdirp(join(claude, 'commands'));
    await writeFile(commandPath(), older);
    const result = await setup();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`updated ${commandPath()}\n`);
    expect(await readFile(commandPath(), 'utf8')).toBe(commandFileText(ABSOLUTE()));
  });

  it('setup/command-file-marker-overwrite (link): a command file that is a symbolic link is written at its target, the link stays', async () => {
    const dotfiles = await mkdirp(join(temp.root, 'dotfiles'));
    await writeFile(join(dotfiles, 'diffcity-review.md'), `---\ndescription: x\n---\n${COMMAND_MARKER}\nold\n`);
    await mkdirp(join(claude, 'commands'));
    await symlink(join(dotfiles, 'diffcity-review.md'), commandPath());
    expect((await setup()).code).toBe(0);
    expect(await readlink(commandPath())).toBe(join(dotfiles, 'diffcity-review.md'));
    expect(await readFile(join(dotfiles, 'diffcity-review.md'), 'utf8')).toBe(commandFileText(ABSOLUTE()));
  });

  it('setup/foreign-command-file-refused: a diffcity-review.md without the marker is refused; nothing is written', async () => {
    const foreign = '---\ndescription: my own review\n---\nReview the change carefully.\n';
    await mkdirp(join(claude, 'commands'));
    await writeFile(commandPath(), foreign);
    const result = await setup();
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: `diffcity setup-claude: refused: ${commandPath()} exists and was not written by diffcity (no ${COMMAND_MARKER} line after its frontmatter); move it away and run setup-claude again\n`,
    });
    expect(await snapshot(claude)).toEqual({ 'commands/diffcity-review.md': foreign });
  });
});

describe('setup-claude --remove', () => {
  it('setup/remove-only-ours: removes our command file and our hook; every other hook and key stays', async () => {
    await writeFile(join(await mkdirp(claude), 'settings.json'), JSON.stringify(existingSettings));
    expect((await setup()).code).toBe(0);
    const result = await setup({ remove: true });
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        `deleted ${commandPath()}`,
        `updated ${settingsPath()} (removed the Stop hook)`,
        `hook command: ${ABSOLUTE()} track --agent`,
        `checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`,
        '',
      ].join('\n'),
    });
    expect(await readOptional(commandPath())).toBeNull();
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual(existingSettings);
  });

  it('setup/remove-only-ours (foreign): a foreign command file and foreign hooks are kept; exit 0', async () => {
    const foreign = '---\ndescription: my own review\n---\nReview the change.\n';
    const settings = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'npx diffcity track --agent' }] }] } };
    await mkdirp(join(claude, 'commands'));
    await writeFile(commandPath(), foreign);
    await writeFile(settingsPath(), JSON.stringify(settings));
    const before = await snapshot(claude);
    const result = await setup({ remove: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`kept ${commandPath()} (not written by diffcity)\n`);
    expect(result.stdout).toContain(`unchanged ${settingsPath()} (no diffcity Stop hook)\n`);
    expect(await snapshot(claude)).toEqual(before);
  });

  it('setup/remove-only-ours (emptied containers): a settings.json diffcity created goes back to {}', async () => {
    expect((await setup()).code).toBe(0);
    expect((await setup({ remove: true })).code).toBe(0);
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({});
  });

  it('setup/remove-only-ours (other invocation): the hook written with the invocation recorded in our command file goes too', async () => {
    expect((await setup()).code).toBe(0);
    // diffcity is now on the PATH as this CLI: the current invocation is `diffcity`.
    const bin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(bin, 'diffcity'));
    const result = await setup({ remove: true }, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: bin } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('hook command: diffcity track --agent\n');
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({});
    expect(await readOptional(commandPath())).toBeNull();
  });

  it('setup/remove-legacy-command-file: a leftover code-review.md with the old marker is deleted with its hook; a foreign one is never touched', async () => {
    const legacyPath = join(claude, 'commands', 'code-review.md');
    const oldCli = '"/opt/sample/node" "/opt/sample/dist/cli/index.js"';
    const legacy = `---\ndescription: Review the current change with diffcity\nallowed-tools: Bash(${oldCli} diff:*), Bash(${oldCli} import:*), Read\n---\n${LEGACY_COMMAND_MARKER}\nRun \`${oldCli} diff --json --compact\`.\n`;
    await mkdirp(join(claude, 'commands'));
    await writeFile(legacyPath, legacy);
    await writeFile(settingsPath(), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `${oldCli} track --agent` }] }] } }));
    const result = await setup({ remove: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`deleted ${legacyPath}\n`);
    expect(await readOptional(legacyPath)).toBeNull();
    // The hook recorded in the old file goes with it.
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({});

    // A code-review.md of the user's own, even one naming diffcity, is never deleted nor mentioned.
    const foreign = '---\ndescription: my own review, run diffcity diff first\n---\nReview the change.\n';
    await writeFile(legacyPath, foreign);
    const again = await setup({ remove: true });
    expect(again.code).toBe(0);
    expect(again.stdout).not.toContain(legacyPath);
    expect(await readFile(legacyPath, 'utf8')).toBe(foreign);
    // The new marker in the old file name is not the old marker either.
    const renamed = `---\ndescription: x\n---\n${COMMAND_MARKER}\n`;
    await writeFile(legacyPath, renamed);
    expect((await setup({ remove: true })).code).toBe(0);
    expect(await readFile(legacyPath, 'utf8')).toBe(renamed);
  });

  it('install never touches a leftover code-review.md', async () => {
    const legacyPath = join(claude, 'commands', 'code-review.md');
    const legacy = `---\ndescription: x\n---\n${LEGACY_COMMAND_MARKER}\n`;
    await mkdirp(join(claude, 'commands'));
    await writeFile(legacyPath, legacy);
    expect((await setup()).code).toBe(0);
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
  });

  it('nothing installed: both files absent, exit 0, nothing created', async () => {
    const result = await setup({ remove: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`absent ${commandPath()}\nabsent ${settingsPath()}\n`);
    expect(await snapshot(claude)).toEqual({});
  });
});

describe('setup-claude --dry-run', () => {
  it('setup/dry-run-writes-nothing: install and remove print what would change and write nothing', async () => {
    await writeFile(join(await mkdirp(claude), 'settings.json'), JSON.stringify(existingSettings));
    const before = await snapshot(claude);
    const dry = await setup({ dryRun: true });
    expect(dry).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        `would back up ${settingsPath()} to ${backupPath()}`,
        `would create ${commandPath()}`,
        `would update ${settingsPath()} (added the Stop hook)`,
        `hook command: ${ABSOLUTE()} track --agent`,
        `checked against Claude Code ${CLAUDE_CODE_CHECKED_VERSION}`,
        '',
      ].join('\n'),
    });
    expect(await snapshot(claude)).toEqual(before);

    expect((await setup()).code).toBe(0);
    const installed = await snapshot(claude);
    const dryRemove = await setup({ remove: true, dryRun: true });
    expect(dryRemove.stdout).toContain(`would delete ${commandPath()}\nwould update ${settingsPath()} (removed the Stop hook)\n`);
    expect(await snapshot(claude)).toEqual(installed);
  });

  it('a dry run with a missing configuration directory creates no directory', async () => {
    expect((await setup({ dryRun: true })).code).toBe(0);
    await expect(stat(claude)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the hook command', () => {
  it('setup/hook-command-global-vs-absolute: `diffcity` only when the diffcity on the PATH is this CLI', async () => {
    const globalBin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(globalBin, 'diffcity'));
    const otherBin = await mkdirp(join(temp.root, 'other-bin'));
    await writeFile(join(otherBin, 'diffcity'), '#!/bin/sh\n', { mode: 0o755 });
    const choose = (pathEnv: string | undefined): ReturnType<typeof chooseCliInvocation> => chooseCliInvocation({ pathEnv, nodePath, cliEntry });

    expect(await choose(`${emptyPath}:${globalBin}`)).toEqual({ ok: true, invocation: { kind: 'global', cli: 'diffcity' } });
    // The first diffcity on the PATH is another one: the hook must not run it.
    expect(await choose(`${otherBin}:${globalBin}`)).toEqual({ ok: true, invocation: { kind: 'absolute', cli: ABSOLUTE() } });
    expect(await choose(emptyPath)).toEqual({ ok: true, invocation: { kind: 'absolute', cli: ABSOLUTE() } });
    expect(await choose(undefined)).toEqual({ ok: true, invocation: { kind: 'absolute', cli: ABSOLUTE() } });
    expect(hookCommand('diffcity')).toBe('diffcity track --agent');

    // Setup prints the one it chose.
    const global = await setup({}, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: globalBin } });
    expect(global.stdout).toContain('hook command: diffcity track --agent\n');
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'diffcity track --agent' }] }] } });
    expect(await readFile(commandPath(), 'utf8')).toBe(commandFileText('diffcity'));
  });

  it('setup/local-bin-is-not-global: a node_modules/.bin copy on the PATH, or a run under npm exec, gives the absolute form', async () => {
    const localBin = await mkdirp(join(temp.root, 'proj', 'node_modules', '.bin'));
    await symlink(cliEntry, join(localBin, 'diffcity'));
    const globalBin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(globalBin, 'diffcity'));
    const absolute = { ok: true, invocation: { kind: 'absolute', cli: ABSOLUTE() } };

    // npx and npm exec put the local bin first on the PATH; its diffcity resolves to this CLI.
    expect(await chooseCliInvocation({ pathEnv: localBin, nodePath, cliEntry })).toEqual(absolute);
    expect(await chooseCliInvocation({ pathEnv: `${localBin}/`, nodePath, cliEntry })).toEqual(absolute);
    // A real global install later on the PATH is still found past the local bin.
    expect(await chooseCliInvocation({ pathEnv: `${localBin}:${globalBin}`, nodePath, cliEntry })).toEqual({ ok: true, invocation: { kind: 'global', cli: 'diffcity' } });
    // Under npm exec (npm_command=exec, npx too) it is never global.
    expect(await chooseCliInvocation({ pathEnv: globalBin, nodePath, cliEntry, npmCommand: 'exec' })).toEqual(absolute);
    expect(await chooseCliInvocation({ pathEnv: globalBin, nodePath, cliEntry, npmCommand: 'run-script' })).toEqual({ ok: true, invocation: { kind: 'global', cli: 'diffcity' } });
    expect(isLocalBin('/work/proj/node_modules/.bin')).toBe(true);
    expect(isLocalBin('/work/proj/node_modules/.bin/')).toBe(true);
    expect(isLocalBin('/work/proj/.bin')).toBe(false);
    expect(isLocalBin('/opt/sample/bin')).toBe(false);

    // Through setup: the env's npm_command is read.
    const result = await setup({}, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: globalBin, npm_command: 'exec' } });
    expect(result.stdout).toContain(`hook command: ${ABSOLUTE()} track --agent\n`);
  });

  it('a path the shell, YAML or the allow-list cannot carry is refused with the reason', async () => {
    for (const bad of ['/opt/sample"tools/node', '/opt/sample$HOME/node', '/opt/sample (x86)/node', '/opt/sample: tools/node', '/opt/sample #1/node']) {
      const choice = await chooseCliInvocation({ pathEnv: emptyPath, nodePath: bad, cliEntry });
      expect(choice).toMatchObject({ ok: false, error: expect.stringContaining('install diffcity globally') as unknown });
    }
    const result = await setup({}, { nodePath: '/opt/sample (x86)/node' });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('diffcity setup-claude: cannot use "/opt/sample (x86)/node" in the hook command: it contains "("; install diffcity globally (npm i -g diffcity) and run setup-claude again\n');
    expect(await snapshot(claude)).toEqual({});
  });

  it('setup/allowed-tools-match-hook-command: the written allow-list prefixes are the written hook command without "track --agent"', async () => {
    const globalBin = await mkdirp(join(temp.root, 'global-bin'));
    await symlink(cliEntry, join(globalBin, 'diffcity'));
    for (const pathEnv of [emptyPath, globalBin]) {
      await rm(claude, { recursive: true, force: true });
      expect((await setup({}, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: pathEnv } })).code).toBe(0);
      const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
      const hook = settings.hooks.Stop[0]?.hooks[0]?.command ?? '';
      expect(hook).toMatch(/ track --agent$/);
      const cli = hook.slice(0, -' track --agent'.length);
      const lines = (await readFile(commandPath(), 'utf8')).split('\n');
      const start = lines.indexOf('allowed-tools:');
      expect(lines.slice(start, start + 7)).toEqual([
        'allowed-tools:',
        `  - Bash(${cli} diff:*)`,
        `  - Bash(${cli} import:*)`,
        '  - Bash(mv .diffcity/fix-queue.json .diffcity/fix-queue.taking.json)',
        '  - Bash(rm .diffcity/fix-queue.taking.json)',
        '  - Read',
        '  - Write(.diffcity/findings.json)',
      ]);
    }
  });

  it('the hook command as written runs through a shell, with the Stop JSON on stdin, and reaches the daemon (exit 0)', async () => {
    const repo = await createRepo({ name: 'sample-depot', files: { 'src/crates.ts': 'export const crates = 1;\n' } });
    daemons.track(temp.home);
    const fake = await startFakeDaemon(homePaths(temp.home));
    try {
      // The real built CLI and node: the absolute form, as setup writes it.
      expect((await setup({}, { nodePath: process.execPath, cliEntry: CLI_DIST })).code).toBe(0);
      const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
      const command = settings.hooks.Stop[0]?.hooks[0]?.command ?? '';
      expect(command).toBe(`"${process.execPath}" "${CLI_DIST}" track --agent`);
      const child = spawn('/bin/sh', ['-c', command], { cwd: repo.dir, env: temp.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stdin.end(JSON.stringify({ session_id: 'session-0107', transcript_path: '/work/transcripts/session-0107.jsonl', cwd: repo.dir, hook_event_name: 'Stop' }));
      expect(await new Promise((resolve) => child.once('exit', resolve))).toBe(0);
      expect(stdout).toBe('tracked sample-depot\n');
      expect(fake.requests).toMatchObject([{ type: 'track', dir: repo.dir, agent: true }]);
    } finally {
      await fake.close();
      await repo.cleanup();
    }
  });
});

describe('setup-claude --repo', () => {
  it("writes the repo's .claude/ from any folder of the repo, and warns that absolute paths must not be committed", async () => {
    const repo = await createRepo({ name: 'sample-depot', files: { 'src/crates.ts': 'export const crates = 1;\n' } });
    try {
      // git reports the root with symbolic links resolved (/private/var on macOS).
      const root = await realpath(repo.dir);
      const result = await setup({ repo: true }, { cwd: join(repo.dir, 'src') });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`created ${join(root, '.claude', 'commands', 'diffcity-review.md')}\n`);
      expect(result.stdout).toContain(`created ${join(root, '.claude', 'settings.json')}\n`);
      expect(result.stderr).toBe(
        'diffcity setup-claude: warning: the hook command holds absolute paths of this machine; do not commit these files, or install diffcity globally and run setup-claude again\n',
      );
      expect(await snapshot(claude)).toEqual({});
      // An explicit <dir> works the same; with the global form there is no warning.
      const bin = await mkdirp(join(temp.root, 'global-bin'));
      await symlink(cliEntry, join(bin, 'diffcity'));
      const again = await setup({ repo: repo.dir }, { cwd: temp.userHome, env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude, PATH: bin } });
      expect(again).toMatchObject({ code: 0, stderr: '' });
      expect(await readFile(join(repo.dir, '.claude', 'commands', 'diffcity-review.md'), 'utf8')).toBe(commandFileText('diffcity'));
    } finally {
      await repo.cleanup();
    }
  });

  it('outside a repo: exit 1, nothing written', async () => {
    const outside = await mkdirp(join(temp.root, 'plain-notes'));
    const result = await setup({ repo: outside });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`diffcity setup-claude: not a git repository: ${outside}\n`);
    expect(await snapshot(outside)).toEqual({});
  });
});

describe('setup/temp-claude-config-dir-only', () => {
  it('the test run points CLAUDE_CONFIG_DIR and HOME into the temporary directory', () => {
    const tmp = tmpdir();
    const inside = (path: string | undefined): boolean => path !== undefined && (path.startsWith(`${tmp}${sep}`) || path.startsWith(tmp));
    expect(inside(process.env[CLAUDE_CONFIG_DIR_ENV])).toBe(true);
    expect(inside(process.env.HOME)).toBe(true);
    expect(claudeConfigDir(process.env)).toBe(process.env[CLAUDE_CONFIG_DIR_ENV]);
  });

  it('claudeConfigDir: CLAUDE_CONFIG_DIR wins, an empty one is unset, a relative one is refused, HOME/.claude otherwise', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: claude, HOME: '/home/sample' })).toBe(claude);
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '', HOME: '/home/sample' })).toBe('/home/sample/.claude');
    expect(claudeConfigDir({ HOME: '/home/sample' })).toBe('/home/sample/.claude');
    expect(() => claudeConfigDir({ CLAUDE_CONFIG_DIR: 'relative/claude' })).toThrow('CLAUDE_CONFIG_DIR must be an absolute path, got "relative/claude"');
  });

  it('the built CLI writes under CLAUDE_CONFIG_DIR only, never under HOME/.claude', async () => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [CLI_DIST, 'setup-claude'],
        { cwd: temp.userHome, env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: claude } },
        (error, stdout, stderr) => {
          resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
        },
      );
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`created ${commandPath()}\n`);
    expect(Object.keys(await snapshot(claude)).sort()).toEqual(['commands/diffcity-review.md', 'settings.json']);
    expect(await snapshot(temp.userHome)).toEqual({});
    // setup writes no daemon settings: the diffcity home is not even created.
    await expect(stat(temp.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a relative CLAUDE_CONFIG_DIR is refused before anything is written', async () => {
    const result = await setup({}, { env: { ...temp.env, [CLAUDE_CONFIG_DIR_ENV]: 'relative/claude', PATH: emptyPath } });
    expect(result).toEqual({ code: 1, stdout: '', stderr: 'diffcity setup-claude: CLAUDE_CONFIG_DIR must be an absolute path, got "relative/claude"\n' });
  });
});

async function mkdirp(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

