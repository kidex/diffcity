// scripts/jira-attach.mjs: arguments, credentials from the environment and
// from a stubbed Keychain, the upload request, and the token never showing in
// any output. fetch, `security` and the file system are stubs: no network, no
// real Keychain.

import { describe, expect, it } from 'vitest';
import {
  keychainAttribute,
  main,
  parseArgs,
  SETUP_HINT,
  type JiraAttachIo,
} from '../../../scripts/jira-attach.mjs';

// Invented values only.
const PAT = 'fake-pat-0042-zz';
const EMAIL = 'reviewer@example.test';
const SITE = 'https://jira.example.test';

/** What `security find-generic-password -s diffcity-jira` prints for an item made with -a EMAIL -j SITE. */
const LISTING = [
  'keychain: "/var/empty/login.keychain-db"',
  'version: 512',
  'class: "genp"',
  'attributes:',
  '    0x00000007 <blob>="diffcity-jira"',
  '    0x00000008 <blob>=<NULL>',
  `    "acct"<blob>="${EMAIL}"`,
  '    "cdat"<timedate>=0x32303236313030313132303030305A00  "20261001120000Z\\000"',
  '    "desc"<blob>=<NULL>',
  `    "icmt"<blob>="${SITE}"`,
  '    "svce"<blob>="diffcity-jira"',
  '',
].join('\n');

interface Call {
  url: string;
  init: RequestInit;
}

interface Harness {
  io: JiraAttachIo;
  out: string[];
  err: string[];
  calls: Call[];
  securityCalls: string[][];
}

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  /** Answers of the stubbed `security`, by whether the call asks for the password (-w). */
  listing?: string | null;
  password?: string | null;
  response?: () => Response | Promise<Response>;
  files?: Record<string, string>;
}

function harness(options: HarnessOptions = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const securityCalls: string[][] = [];
  const files = options.files ?? { 'proof/DC-35.webm': 'webm-bytes' };
  const io: JiraAttachIo = {
    env: options.env ?? {},
    security: (args) => {
      securityCalls.push(args);
      if (args.includes('-w')) return Promise.resolve(options.password === undefined ? `${PAT}\n` : options.password);
      return Promise.resolve(options.listing === undefined ? LISTING : options.listing);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return options.response
        ? options.response()
        : new Response(JSON.stringify([{ id: '10501', filename: 'DC-35.webm', size: 10 }]), { status: 200 });
    },
    readFile: (path) => {
      const content = files[path];
      return content === undefined ? Promise.reject(new Error(`no ${path}`)) : Promise.resolve(new TextEncoder().encode(content));
    },
    isFile: (path) => Promise.resolve(path in files),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { io, out, err, calls, securityCalls };
}

/** Everything the script printed, on both streams. */
const printed = (h: Harness): string => [...h.out, ...h.err].join('\n');

describe('arguments', () => {
  it('needs an issue key and at least one file', () => {
    expect(parseArgs([])).toHaveProperty('error');
    expect(parseArgs(['DC-35'])).toHaveProperty('error');
    expect(parseArgs(['DC-35', 'a.webm', 'b.png'])).toEqual({ key: 'DC-35', files: ['a.webm', 'b.png'] });
  });

  it('refuses something that is not an issue key, and unknown options', () => {
    expect(parseArgs(['dc-35', 'a.webm'])).toHaveProperty('error');
    expect(parseArgs(['DC-0', 'a.webm'])).toHaveProperty('error');
    expect(parseArgs(['../DC-35', 'a.webm'])).toHaveProperty('error');
    expect(parseArgs(['DC-35', '--base-url', 'a.webm'])).toHaveProperty('error');
  });

  it('exits 1 on a usage error or a missing file, before looking for credentials', async () => {
    const usage = harness();
    expect(await main(['DC-35'], usage.io)).toBe(1);
    expect(usage.err.join('\n')).toMatch(/usage: node scripts\/jira-attach\.mjs/);

    const missing = harness();
    expect(await main(['DC-35', 'proof/none.webm'], missing.io)).toBe(1);
    expect(missing.err).toEqual(['not a file: proof/none.webm']);
    expect(missing.securityCalls).toEqual([]);
    expect(missing.calls).toEqual([]);
  });
});

describe('the Keychain listing', () => {
  it('reads the account and the comment, as text or as hex', () => {
    expect(keychainAttribute(LISTING, 'acct')).toBe(EMAIL);
    expect(keychainAttribute(LISTING, 'icmt')).toBe(SITE);
    expect(keychainAttribute(LISTING, 'desc')).toBeNull();
    expect(keychainAttribute(LISTING, 'gena')).toBeNull();
    const hex = Buffer.from(SITE).toString('hex').toUpperCase();
    expect(keychainAttribute(`    "icmt"<blob>=0x${hex}  "${SITE}"\n`, 'icmt')).toBe(SITE);
  });
});

describe('credentials', () => {
  it('come from the environment alone when all three are set: the Keychain is not asked', async () => {
    const h = harness({ env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: PAT, JIRA_BASE_URL: `${SITE}/` } });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(0);
    expect(h.securityCalls).toEqual([]);
    expect(h.calls[0]?.url).toBe(`${SITE}/rest/api/3/issue/DC-35/attachments`);
  });

  it('fall back to the Keychain: account, comment as the base URL, then the password for that account', async () => {
    const h = harness();
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(0);
    expect(h.securityCalls).toEqual([
      ['find-generic-password', '-s', 'diffcity-jira'],
      ['find-generic-password', '-s', 'diffcity-jira', '-a', EMAIL, '-w'],
    ]);
    const auth = new Headers(h.calls[0]?.init.headers).get('authorization');
    expect(auth).toBe(`Basic ${Buffer.from(`${EMAIL}:${PAT}`).toString('base64')}`);
  });

  it('take the token from the environment and the rest from the Keychain', async () => {
    const h = harness({ env: { JIRA_API_TOKEN: PAT }, password: null });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(0);
    expect(h.securityCalls).toEqual([['find-generic-password', '-s', 'diffcity-jira']]);
  });

  it('use JIRA_EMAIL for the Keychain password lookup when it is set', async () => {
    const h = harness({ env: { JIRA_EMAIL: 'other@example.test', JIRA_BASE_URL: SITE } });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(0);
    expect(h.securityCalls).toEqual([['find-generic-password', '-s', 'diffcity-jira', '-a', 'other@example.test', '-w']]);
  });

  it('missing: exit 2 with the one line that says how to add the Keychain item', async () => {
    const none = harness({ listing: null, password: null });
    expect(await main(['DC-35', 'proof/DC-35.webm'], none.io)).toBe(2);
    expect(none.err).toEqual([SETUP_HINT]);
    expect(SETUP_HINT).toContain('security add-generic-password -s diffcity-jira -a <email> -j <base-url> -w');
    expect(none.calls).toEqual([]);

    // An item without a comment and no JIRA_BASE_URL: no base URL.
    const noSite = harness({ listing: LISTING.replace(`"icmt"<blob>="${SITE}"`, '"icmt"<blob>=<NULL>') });
    expect(await main(['DC-35', 'proof/DC-35.webm'], noSite.io)).toBe(2);
    expect(noSite.err).toEqual([SETUP_HINT]);

    // The item exists but has no password for the account.
    const noPassword = harness({ password: null });
    expect(await main(['DC-35', 'proof/DC-35.webm'], noPassword.io)).toBe(2);
    expect(noPassword.calls).toEqual([]);
  });

  it('refuse a base URL that is not https, without sending the token', async () => {
    const h = harness({ env: { JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: PAT, JIRA_BASE_URL: 'http://jira.example.test' } });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(2);
    expect(h.err).toEqual(['the Jira base URL must use https']);
    expect(h.calls).toEqual([]);
  });
});

describe('the upload', () => {
  it('posts every file as a multipart `file` part with the XSRF header and prints id and name of each attachment', async () => {
    const h = harness({
      files: { 'proof/DC-35.webm': 'video', 'notes/run.txt': 'log' },
      response: () =>
        new Response(JSON.stringify([{ id: '10501', filename: 'DC-35.webm' }, { id: '10502', filename: 'run.txt' }]), { status: 200 }),
    });
    expect(await main(['DC-35', 'proof/DC-35.webm', 'notes/run.txt'], h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
    const init = h.calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-atlassian-token')).toBe('no-check');
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    const parts = (form as FormData).getAll('file') as File[];
    expect(parts.map((part) => [part.name, part.type])).toEqual([
      ['DC-35.webm', 'video/webm'],
      ['run.txt', 'text/plain'],
    ]);
    expect(await parts[0]?.text()).toBe('video');
    expect(h.out).toEqual(['10501\tDC-35.webm', '10502\trun.txt']);
    expect(h.err).toEqual([]);
  });

  it('exits 1 on an HTTP error with the status, and the token never shows in any output', async () => {
    const basic = Buffer.from(`${EMAIL}:${PAT}`).toString('base64');
    const h = harness({ response: () => new Response(`denied for ${PAT} (${basic})`, { status: 401 }) });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(1);
    expect(h.err.join('\n')).toMatch(/HTTP 401/);
    expect(printed(h)).not.toContain(PAT);
    expect(printed(h)).not.toContain(basic);
  });

  it('exits 1 when the request throws, without the token in the message', async () => {
    const h = harness({
      response: () => {
        throw new Error(`connect failed with ${PAT}`);
      },
    });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(1);
    expect(h.err.join('\n')).toMatch(/upload to DC-35 failed/);
    expect(printed(h)).not.toContain(PAT);
  });

  it('exits 1 when the answer is not a list of attachments', async () => {
    const h = harness({ response: () => new Response('<html></html>', { status: 200 }) });
    expect(await main(['DC-35', 'proof/DC-35.webm'], h.io)).toBe(1);
  });
});
