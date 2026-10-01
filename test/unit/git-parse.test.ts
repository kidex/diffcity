import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnv } from '../../src/core/git/exec.js';
import { parseDiffOutput } from '../../src/core/git/index.js';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function raw(src: string, dst: string, status: string, ...paths: string[]): string {
  return [`:${src} ${dst} ${src === '000000' ? Z : A} ${dst === '000000' ? Z : B} ${status}`, ...paths]
    .map((token) => `${token}\0`)
    .join('');
}

describe('parseDiffOutput', () => {
  it('maps raw statuses to change types and numstat "-" to binary', () => {
    const output =
      raw('000000', '100644', 'A', 'lib/new.ts') +
      raw('100644', '000000', 'D', 'lib/gone.ts') +
      raw('100644', '100644', 'M', 'img/logo.png') +
      raw('100644', '100755', 'M', 'bin/run.sh') +
      raw('100644', '120000', 'T', 'lib/link.ts') +
      raw('100644', '100644', 'R087', 'lib/old.ts', 'lib/renamed.ts') +
      '3\t0\tlib/new.ts\0' +
      '0\t4\tlib/gone.ts\0' +
      '-\t-\timg/logo.png\0' +
      '0\t0\tbin/run.sh\0' +
      '1\t1\tlib/link.ts\0' +
      '2\t1\t\0lib/old.ts\0lib/renamed.ts\0';
    expect(parseDiffOutput(output)).toEqual([
      { path: 'lib/new.ts', oldPath: null, type: 'add', binary: false },
      { path: 'lib/gone.ts', oldPath: 'lib/gone.ts', type: 'del', binary: false },
      { path: 'img/logo.png', oldPath: 'img/logo.png', type: 'mod', binary: true },
      { path: 'bin/run.sh', oldPath: 'bin/run.sh', type: 'mod', binary: false },
      { path: 'lib/link.ts', oldPath: 'lib/link.ts', type: 'mod', binary: false },
      { path: 'lib/renamed.ts', oldPath: 'lib/old.ts', type: 'rename', binary: false },
    ]);
  });

  it('marks a binary rename by its new path', () => {
    const output = raw('100644', '100644', 'R100', 'a.bin', 'b.bin') + '-\t-\t\0a.bin\0b.bin\0';
    expect(parseDiffOutput(output)).toEqual([{ path: 'b.bin', oldPath: 'a.bin', type: 'rename', binary: true }]);
  });

  it('never mistakes a path for a record header, even one starting with ":" or containing tabs', () => {
    const output =
      raw('000000', '100644', 'A', ':odd name.ts') + raw('000000', '100644', 'A', 'tab\there.ts') +
      '1\t0\t:odd name.ts\0' + '-\t-\ttab\there.ts\0';
    expect(parseDiffOutput(output)).toEqual([
      { path: ':odd name.ts', oldPath: null, type: 'add', binary: false },
      { path: 'tab\there.ts', oldPath: null, type: 'add', binary: true },
    ]);
  });

  it('skips submodules (gitlinks)', () => {
    const output = raw('160000', '160000', 'M', 'vendor/lib') + raw('000000', '160000', 'A', 'vendor/other');
    expect(parseDiffOutput(output)).toEqual([]);
  });

  it('returns nothing for empty output', () => {
    expect(parseDiffOutput('')).toEqual([]);
  });
});

describe('gitEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets GIT_OPTIONAL_LOCKS=0 and drops variables that redirect git to another repo', () => {
    vi.stubEnv('GIT_DIR', '/elsewhere/.git');
    vi.stubEnv('GIT_INDEX_FILE', '/elsewhere/index');
    vi.stubEnv('GIT_WORK_TREE', '/elsewhere');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    const env = gitEnv();
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('refuses every transport and lazy fetch, whatever the caller environment allows', () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file:ext');
    vi.stubEnv('GIT_NO_LAZY_FETCH', '0');
    const env = gitEnv();
    expect(env.GIT_ALLOW_PROTOCOL).toBe('');
    expect(env.GIT_NO_LAZY_FETCH).toBe('1');
  });
});
