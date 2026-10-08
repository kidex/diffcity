// The `/diffcity-review` command file (SPEC.md section 7.1, ADR-037): the text is
// SPEC 7.1 with its frontmatter, the version marker sits right after the
// frontmatter, and every command the body runs is allowed by `allowed-tools`.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_FILE_NAME,
  COMMAND_MARKER,
  LEGACY_COMMAND_MARKER,
  allowedTools,
  commandFileText,
  isDiffcityCommandFile,
  recordedCli,
  slashCommands,
} from '../../../src/core/claude/command-file.js';
import { hookCommand } from '../../../src/core/claude/hook-command.js';

const ABSOLUTE = '"/opt/sample tools/node" "/opt/sample tools/diffcity/dist/cli/index.js"';
const INVOCATIONS = ['diffcity', ABSOLUTE];

/** The code block of SPEC.md section 7.1. */
async function spec71(): Promise<string> {
  const spec = await readFile(new URL('../../../SPEC.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('### 7.1 '), spec.indexOf('### 7.2 '));
  const match = /```[a-z]*\n([\s\S]*?)```/.exec(section);
  if (match?.[1] === undefined) throw new Error('SPEC.md section 7.1 has no code block');
  return match[1];
}

/** The `allowed-tools` entries: the YAML list right under `allowed-tools:`, one entry per item. */
function toolEntries(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('allowed-tools:');
  if (start < 0) throw new Error('no allowed-tools key');
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item?.[1] === undefined) break;
    entries.push(item[1]);
  }
  return entries;
}

/** Whether a Bash rule allows `command`, as Claude Code 2.1.288 matches: `prefix:*` or the exact command. */
function bashAllows(rule: string, command: string): boolean {
  const content = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (content === undefined) return false;
  const prefix = /^(.+):\*$/.exec(content)?.[1];
  if (prefix !== undefined) return command === prefix || command.startsWith(`${prefix} `);
  return command === content;
}

/** The commands the body tells the agent to run (`Run \`...\``). */
function bodyCommands(text: string): string[] {
  return [...text.matchAll(/[Rr]un `([^`]+)`/g)].map((match) => match[1] ?? '');
}

describe('slash: the /diffcity-review command file', () => {
  it('slash/body-matches-spec-7-1: the file for a global install is the SPEC 7.1 block, frontmatter included', async () => {
    expect(commandFileText('diffcity')).toBe(await spec71());
  });

  it('slash/uses-compact-and-open: the body runs diff --json --compact and import --open with the hook invocation', () => {
    for (const cli of INVOCATIONS) {
      const text = commandFileText(cli);
      expect(bodyCommands(text)).toEqual([
        'mv .diffcity/fix-queue .diffcity/fix-queue.taking',
        'rm -r .diffcity/fix-queue.taking',
        `${cli} diff --json --compact`,
        `${cli} import .diffcity/findings.json --open`,
      ]);
      expect(slashCommands(cli)).toMatchObject({ diff: `${cli} diff --json --compact`, import: `${cli} import .diffcity/findings.json --open` });
      // The fix queue is taken before the review, the import comes last.
      expect(text.indexOf('fix-queue.taking')).toBeLessThan(text.indexOf('diff --json --compact'));
      expect(text.trimEnd().endsWith(`Then run \`${cli} import .diffcity/findings.json --open\`.`)).toBe(true);
    }
  });

  it('slash/allowed-tools-cover-the-body: every command the body runs is allowed, and nothing else is', () => {
    for (const cli of INVOCATIONS) {
      const text = commandFileText(cli);
      const entries = toolEntries(text);
      expect(entries).toEqual([
        `Bash(${cli} diff:*)`,
        `Bash(${cli} import:*)`,
        'Bash(mv .diffcity/fix-queue .diffcity/fix-queue.taking)',
        'Bash(rm -r .diffcity/fix-queue.taking)',
        'Read',
        'Glob',
        'Write(.diffcity/findings.json)',
      ]);
      expect(entries).toEqual(allowedTools(cli));
      for (const command of bodyCommands(text)) expect(entries.some((rule) => bashAllows(rule, command))).toBe(true);
      // The rules are no wider than the body: another subcommand or another file is not allowed.
      expect(entries.some((rule) => bashAllows(rule, `${cli} track --agent`))).toBe(false);
      expect(entries.some((rule) => bashAllows(rule, 'rm -r .diffcity/fix-queue'))).toBe(false);
      expect(entries.some((rule) => bashAllows(rule, 'rm -r .diffcity'))).toBe(false);
      expect(entries.some((rule) => bashAllows(rule, 'rm -rf .diffcity'))).toBe(false);
      expect(entries.some((rule) => bashAllows(rule, 'rm -r .diffcity/fix-queue.taking /'))).toBe(false);
    }
  });

  it('slash/glob-limit: past the Glob limit the items are read one hex prefix at a time, before the taken directory is removed', () => {
    const text = commandFileText('diffcity');
    const prefixRead = text.indexOf('one hex prefix at a time');
    expect(prefixRead).toBeGreaterThan(-1);
    expect(text).toContain('.diffcity/fix-queue.taking/**/0*.json');
    expect(text).toContain('.diffcity/fix-queue.taking/**/f*.json');
    expect(prefixRead).toBeLessThan(text.indexOf('Then run `rm -r .diffcity/fix-queue.taking`'));
  });

  it('slash/paths-from-repo-root: the body says its paths are relative to the repository root, right after the marker', () => {
    const lines = commandFileText('diffcity').split('\n');
    expect(lines[lines.indexOf(COMMAND_MARKER) + 1]).toBe('All paths below are relative to the repository root: run every command from there.');
  });

  it('slash/allowed-tools-yaml-list: allowed-tools is a YAML list, one rule per item, every item a plain YAML value', () => {
    for (const cli of INVOCATIONS) {
      const lines = commandFileText(cli).split('\n');
      const start = lines.indexOf('allowed-tools:');
      expect(lines.slice(start + 1, start + 8)).toEqual(allowedTools(cli).map((entry) => `  - ${entry}`));
      expect(lines[start + 8]).toBe('---');
      // Nothing in an item that YAML would read as a mapping or a comment.
      for (const entry of allowedTools(cli)) expect(entry).not.toMatch(/: | #/);
    }
  });

  it('the marker is the line right after the frontmatter, and the frontmatter opens the file', () => {
    const lines = commandFileText('diffcity').split('\n');
    expect(lines[0]).toBe('---');
    const close = lines.indexOf('---', 1);
    expect(lines.slice(1, close).filter((line) => !line.startsWith(' ')).map((line) => line.split(':')[0])).toEqual(['description', 'argument-hint', 'disable-model-invocation', 'allowed-tools']);
    expect(lines[close + 1]).toBe(COMMAND_MARKER);
  });

  it('slash/user-only: the command is /diffcity-review, started by the user only, with its own marker', () => {
    const text = commandFileText('diffcity');
    expect(COMMAND_FILE_NAME).toBe('diffcity-review.md');
    expect(COMMAND_MARKER).toBe('<!-- diffcity: diffcity-review v1 -->');
    expect(text.split('\n')).toContain('disable-model-invocation: true');
    // The old name's marker is not ours any more: a file with it is a leftover, not the current command.
    expect(LEGACY_COMMAND_MARKER).toBe('<!-- diffcity: code-review v1 -->');
    expect(isDiffcityCommandFile(text.replace(COMMAND_MARKER, LEGACY_COMMAND_MARKER))).toBe(false);
    expect(isDiffcityCommandFile(text.replace(COMMAND_MARKER, LEGACY_COMMAND_MARKER), LEGACY_COMMAND_MARKER)).toBe(true);
  });

  it('isDiffcityCommandFile: only the marker right after the frontmatter makes a file ours', () => {
    expect(isDiffcityCommandFile(commandFileText('diffcity'))).toBe(true);
    expect(isDiffcityCommandFile(commandFileText(ABSOLUTE).replaceAll('\n', '\r\n'))).toBe(true);
    expect(isDiffcityCommandFile(`---\ndescription: mine\n---\n${COMMAND_MARKER}\nmy own text\n`)).toBe(true);
    expect(isDiffcityCommandFile('---\ndescription: a review of my own\n---\nReview the change.\n')).toBe(false);
    expect(isDiffcityCommandFile(`${COMMAND_MARKER}\n---\ndescription: x\n---\n`)).toBe(false);
    expect(isDiffcityCommandFile(`---\ndescription: x\n---\n\n${COMMAND_MARKER}\n`)).toBe(false);
    expect(isDiffcityCommandFile(`---\ndescription: x\n---\n${COMMAND_MARKER.replace('v1', 'v2')}\n`)).toBe(false);
    expect(isDiffcityCommandFile(`Review the change.\n${COMMAND_MARKER}\n`)).toBe(false);
    expect(isDiffcityCommandFile('')).toBe(false);
  });

  it('recordedCli reads the invocation back from a diffcity file, in the list form and the first comma form', () => {
    for (const cli of INVOCATIONS) expect(recordedCli(commandFileText(cli))).toBe(cli);
    const commaForm = `---\nallowed-tools: Bash(${ABSOLUTE} diff:*), Bash(${ABSOLUTE} import:*), Read\n---\n${COMMAND_MARKER}\n`;
    expect(recordedCli(commaForm)).toBe(ABSOLUTE);
    expect(recordedCli('---\ndescription: x\n---\nhello\n')).toBeNull();
  });

  it('setup/allowed-tools-match-hook-command (text): the Bash prefixes are the hook command without "track --agent"', () => {
    for (const cli of INVOCATIONS) {
      const hook = hookCommand(cli);
      expect(hook.endsWith(' track --agent')).toBe(true);
      const invocation = hook.slice(0, -' track --agent'.length);
      expect(toolEntries(commandFileText(cli)).slice(0, 2)).toEqual([`Bash(${invocation} diff:*)`, `Bash(${invocation} import:*)`]);
    }
  });
});
