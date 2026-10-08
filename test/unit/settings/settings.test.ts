// The user settings file (ADR-030, DC-53): <DIFFCITY_HOME>/settings.json holds
// the trusted repos, the only place trust lives. An invalid file is reported
// and trusts nothing; writes are atomic with mode 0600 and keep unknown fields.

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SettingsError,
  addTrustedRepo,
  createRuleSettingsReader,
  createTrustCheck,
  parseSettings,
  readSettings,
  readToolSetting,
  removeTrustedRepo,
  ruleSettingsFor,
  toolSettingFor,
  writeSettings,
} from '../../../src/core/settings/index.js';
import { mergeRules } from '../../../src/core/rules/index.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseSettings', () => {
  it('reads v and trustedRepos', () => {
    expect(parseSettings('{"v":1,"trustedRepos":["/work/sample-shop"]}')).toEqual({
      ok: true,
      settings: { v: 1, trustedRepos: ['/work/sample-shop'] },
    });
  });

  it('treats a missing trustedRepos as an empty list', () => {
    expect(parseSettings('{"v":1}')).toEqual({ ok: true, settings: { v: 1, trustedRepos: [] } });
  });

  it('keeps unknown fields', () => {
    const parsed = parseSettings('{"v":1,"trustedRepos":[],"theme":{"dark":true}}');
    expect(parsed).toEqual({ ok: true, settings: { v: 1, trustedRepos: [], theme: { dark: true } } });
  });

  it.each([
    ['invalid JSON', '{"v":1,', /not valid JSON/],
    ['a top level that is not an object', '["/work/sample-shop"]', /must be a JSON object/],
    ['null', 'null', /must be a JSON object/],
    ['a missing v', '{"trustedRepos":[]}', /"v" must be 1/],
    ['another version', '{"v":2,"trustedRepos":[]}', /"v" must be 1/],
    ['trustedRepos not an array', '{"v":1,"trustedRepos":"/work/sample-shop"}', /"trustedRepos" must be an array/],
    ['a non-string entry', '{"v":1,"trustedRepos":["/work/sample-shop",7]}', /"trustedRepos" must be an array of absolute paths/],
    ['a relative entry', '{"v":1,"trustedRepos":["sample-shop"]}', /"trustedRepos" must be an array of absolute paths/],
  ])('rejects %s', (_name, text, message) => {
    const parsed = parseSettings(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toMatch(message);
  });
});

describe('readSettings', () => {
  it('gives empty settings when the file is missing', async () => {
    expect(await readSettings(file)).toEqual({ ok: true, settings: { v: 1, trustedRepos: [] } });
  });

  it('names the file in the error of an invalid file', async () => {
    await writeFile(file, 'not json');
    const read = await readSettings(file);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.error).toContain(file);
  });
});

describe('writeSettings', () => {
  it('writes the file with mode 0600, even over a wider file', async () => {
    await writeFile(file, '{}', { mode: 0o644 });
    await writeSettings(file, { v: 1, trustedRepos: ['/work/sample-shop'] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, trustedRepos: ['/work/sample-shop'] });
  });

  it('is atomic: no temporary file is left and a reader sees either version, never a partial one', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `/work/repo-${String(i)}`);
    await writeSettings(file, { v: 1, trustedRepos: ['/work/first'] });
    const reads: Promise<unknown>[] = [];
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(writeSettings(file, { v: 1, trustedRepos: i % 2 === 0 ? big : ['/work/first'] }));
      reads.push(readSettings(file));
    }
    await Promise.all(writes);
    for (const read of await Promise.all(reads)) expect(read).toMatchObject({ ok: true });
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('creates a missing home directory', async () => {
    const nested = join(dir, 'home', 'settings.json');
    await writeSettings(nested, { v: 1, trustedRepos: [] });
    expect((await stat(nested)).mode & 0o777).toBe(0o600);
  });
});

describe('addTrustedRepo and removeTrustedRepo', () => {
  it('adds once, keeps unknown fields, and removes', async () => {
    await writeFile(file, JSON.stringify({ v: 1, trustedRepos: [], theme: 'night' }));
    expect(await addTrustedRepo(file, '/work/sample-shop')).toBe(true);
    expect(await addTrustedRepo(file, '/work/sample-shop')).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, trustedRepos: ['/work/sample-shop'], theme: 'night' });
    expect(await removeTrustedRepo(file, '/work/sample-shop')).toBe(true);
    expect(await removeTrustedRepo(file, '/work/sample-shop')).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, trustedRepos: [], theme: 'night' });
  });

  it('refuses to rewrite an invalid file, which stays as it was', async () => {
    await writeFile(file, '{"v":1,"trustedRepos":"oops"}');
    await expect(addTrustedRepo(file, '/work/sample-shop')).rejects.toBeInstanceOf(SettingsError);
    await expect(removeTrustedRepo(file, '/work/sample-shop')).rejects.toBeInstanceOf(SettingsError);
    expect(await readFile(file, 'utf8')).toBe('{"v":1,"trustedRepos":"oops"}');
  });
});

describe('createTrustCheck', () => {
  it('trusts only listed roots and sees edits without a restart', async () => {
    const invalid: string[] = [];
    const check = createTrustCheck(file, { onInvalid: (message) => invalid.push(message) });
    expect(await check('/work/sample-shop')).toBe(false);
    await writeSettings(file, { v: 1, trustedRepos: ['/work/sample-shop'] });
    expect(await check('/work/sample-shop')).toBe(true);
    expect(await check('/work/other-shop')).toBe(false);
    await writeSettings(file, { v: 1, trustedRepos: [] });
    expect(await check('/work/sample-shop')).toBe(false);
    expect(invalid).toEqual([]);
  });

  it('sees an edit that keeps the size and the mtime second', async () => {
    const check = createTrustCheck(file, { onInvalid: () => undefined });
    await writeFile(file, JSON.stringify({ v: 1, trustedRepos: ['/work/aaaa'] }));
    const fixed = new Date('2026-03-01T00:00:00Z');
    await utimes(file, fixed, fixed);
    expect(await check('/work/aaaa')).toBe(true);
    await writeFile(file, JSON.stringify({ v: 1, trustedRepos: ['/work/bbbb'] }));
    await utimes(file, fixed, fixed);
    // Same size, same mtime: still seen, since the file is read on every check.
    expect(await check('/work/aaaa')).toBe(false);
    expect(await check('/work/bbbb')).toBe(true);
  });

  it('an invalid file trusts nothing and is reported once per version of the file', async () => {
    const invalid: string[] = [];
    const check = createTrustCheck(file, { onInvalid: (message) => invalid.push(message) });
    await writeFile(file, '{"v":1,"trustedRepos":["/work/sample-shop"],');
    expect(await check('/work/sample-shop')).toBe(false);
    expect(await check('/work/sample-shop')).toBe(false);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('not valid JSON');
  });

  it('a directory in place of the file trusts nothing', async () => {
    await mkdir(file);
    const invalid: string[] = [];
    const check = createTrustCheck(file, { onInvalid: (message) => invalid.push(message) });
    expect(await check('/work/sample-shop')).toBe(false);
    expect(invalid).toHaveLength(1);
  });
});

describe('rules in the settings (ADR-030)', () => {
  const SHOP = '/work/shopfront';
  const LEDGER = '/work/ledger';

  it('settings/rules-key-validated: rules and repos.<root>.rules are read for their repo and validated rule by rule; a bad rule untrusts nothing', async () => {
    const settings = {
      v: 1,
      trustedRepos: [SHOP],
      rules: [{ id: 'size', kind: 'file-size', maxLines: 400 }, { id: 'Bad Id', kind: 'file-size', maxLines: 1 }],
      repos: { [SHOP]: { rules: [{ id: 'size', kind: 'file-size', maxLines: 800 }] }, [LEDGER]: { rules: 'none' } },
    };
    await writeFile(file, JSON.stringify(settings));
    const parsed = await readSettings(file);
    expect(parsed).toEqual({ ok: true, settings });
    expect(await createTrustCheck(file, { onInvalid: () => undefined })(SHOP)).toBe(true);

    const reader = createRuleSettingsReader(file);
    expect(await reader(SHOP)).toEqual({ settings: settings.rules, settingsRepo: settings.repos[SHOP].rules });
    expect(await reader('/work/acme-cli')).toEqual({ settings: settings.rules });

    const shop = mergeRules(await reader(SHOP));
    expect(shop.map((entry) => (entry.ok ? `${entry.rule.id}:${entry.origin}` : entry.reason))).toEqual([
      'config-error: settings.json rules: rules[1]: field "id" must match ^[a-z0-9][a-z0-9-]{0,39}$',
      'size:settings-repo',
    ]);
    const ledger = mergeRules(await reader(LEDGER));
    expect(ledger.map((entry) => (entry.ok ? '' : entry.reason))).toContain(
      'config-error: settings.json repo rules: field "rules" must be an array',
    );

    // Writes keep the rules as they are.
    expect(await addTrustedRepo(file, LEDGER)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...settings, trustedRepos: [SHOP, LEDGER] });
  });

  it('a repos value or repo entry that is not an object is a config error, not dropped', () => {
    const base = { v: 1 as const, trustedRepos: [] };
    expect(ruleSettingsFor({ ...base, repos: [SHOP] }, SHOP)).toEqual({ settingsRepo: null });
    expect(ruleSettingsFor({ ...base, repos: { [SHOP]: 'rules' } }, SHOP)).toEqual({ settingsRepo: null });
    expect(ruleSettingsFor({ ...base, repos: { [SHOP]: {} } }, SHOP)).toEqual({});
    expect(ruleSettingsFor({ ...base, repos: {} }, 'toString')).toEqual({});
    expect(mergeRules({ settingsRepo: null }).map((entry) => (entry.ok ? '' : entry.reason))).toEqual([
      'config-error: settings.json repo rules: field "rules" must be an array',
    ]);
  });

  it('an invalid settings file gives no rules', async () => {
    await writeFile(file, '{"v":1,');
    expect(await createRuleSettingsReader(file)(SHOP)).toEqual({});
  });
});

describe('settings.tools (ADR-030, ADR-032)', () => {
  const settings = (tools: unknown) => ({ v: 1 as const, trustedRepos: [], ...(tools === undefined ? {} : { tools }) });

  it('reads tools.<name> as an absolute path, unset when absent', () => {
    expect(toolSettingFor(settings(undefined), 'gh')).toEqual({ kind: 'unset' });
    expect(toolSettingFor(settings({ claude: '/opt/sample/claude' }), 'gh')).toEqual({ kind: 'unset' });
    expect(toolSettingFor(settings({ gh: '/opt/sample/gh' }), 'gh')).toEqual({ kind: 'path', path: '/opt/sample/gh' });
  });

  it.each([
    ['a relative path', { gh: 'bin/gh' }],
    ['a number', { gh: 7 }],
    ['an empty string', { gh: '' }],
  ])('rejects %s without invalidating the file', (_label, tools) => {
    expect(toolSettingFor(settings(tools), 'gh')).toEqual({ kind: 'invalid', message: 'field "tools.gh" must be an absolute path' });
    expect(parseSettings(JSON.stringify(settings(tools))).ok).toBe(true);
  });

  it('rejects a tools field that is not an object', () => {
    expect(toolSettingFor(settings(['/opt/sample/gh']), 'gh').kind).toBe('invalid');
    expect(toolSettingFor(settings('/opt/sample/gh'), 'gh').kind).toBe('invalid');
  });

  it('checks the file: it must exist, be a regular file and be executable', async () => {
    const binary = join(dir, 'gh');
    const write = (tools: unknown) => writeFile(file, JSON.stringify(settings(tools)), 'utf8');

    await write({ gh: binary });
    expect(await readToolSetting(file, 'gh')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('does not exist') as unknown });

    await writeFile(binary, '#!/bin/sh\n', 'utf8');
    await chmod(binary, 0o644);
    expect(await readToolSetting(file, 'gh')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('not executable') as unknown });

    await chmod(binary, 0o755);
    expect(await readToolSetting(file, 'gh')).toEqual({ kind: 'path', path: binary });

    await write({ gh: dir });
    expect(await readToolSetting(file, 'gh')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('not a regular file') as unknown });
  });

  it('a missing settings file sets no tool; an invalid one makes every tool invalid', async () => {
    expect(await readToolSetting(file, 'gh')).toEqual({ kind: 'unset' });
    await writeFile(file, '{ not json', 'utf8');
    expect((await readToolSetting(file, 'gh')).kind).toBe('invalid');
  });
});
