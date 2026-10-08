// The session redactor (ADR-038). Every fake token is assembled at run time:
// the repo's secret guards block literal token prefixes in files.

import { describe, expect, it } from 'vitest';
import { redact } from '../../../src/core/session/redact.js';

const HOME = '/Users/robin';
const join = (...parts: string[]): string => parts.join('');
const run = (alphabet: string, length: number): string => alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const ALNUM = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wX1yZ';
/** The marker of an assignment value. */
const M = ['[redacted', 'secret]'].join(':');

function r(text: string): string {
  return redact(text, { home: HOME });
}

describe('redact', () => {
  it('redact/github-token: classic, OAuth, server and fine-grained tokens', () => {
    for (const prefix of [join('gh', 'p_'), join('gh', 'o_'), join('gh', 's_')]) {
      expect(r(`push with ${prefix}${run(ALNUM, 36)} now`)).toBe('push with [redacted:github-token] now');
    }
    expect(r(`${join('github', '_pat_')}${run(ALNUM, 22)}_${run(ALNUM, 59)}`)).toBe('[redacted:github-token]');
  });

  it('redact/slack-token: xox tokens', () => {
    expect(r(`bot ${join('xo', 'xb-')}1234567890-${run(ALNUM, 24)}.`)).toBe('bot [redacted:slack-token].');
  });

  it('redact/aws-key: AKIA and ASIA access key ids', () => {
    expect(r(`id ${join('AK', 'IA')}${run('ABCDEFGHIJ234567', 16)} ok`)).toBe('id [redacted:aws-key] ok');
    expect(r(`id ${join('AS', 'IA')}${run('QRSTUVWXYZ234567', 16)}`)).toBe('id [redacted:aws-key]');
  });

  it('redact/google-key: AIza keys', () => {
    expect(r(`maps ${join('AI', 'za')}${run(ALNUM + '_-', 35)} end`)).toBe('maps [redacted:google-key] end');
  });

  it('redact/gitlab-token: glpat tokens', () => {
    expect(r(`${join('gl', 'pat-')}${run(ALNUM, 20)}`)).toBe('[redacted:gitlab-token]');
  });

  it('redact/openai-style-key: sk- keys, the Anthropic and project forms included', () => {
    expect(r(`key ${join('s', 'k-')}${run(ALNUM, 48)} used`)).toBe('key [redacted:api-key] used');
    expect(r(`${join('s', 'k-', 'ant-')}api03-${run(ALNUM, 40)}`)).toBe('[redacted:api-key]');
    expect(r(`${join('s', 'k-', 'proj-')}${run(ALNUM, 40)}`)).toBe('[redacted:api-key]');
  });

  it('redact/pem-block: a private key block, and one cut before its end', () => {
    const begin = join('-----BEGIN ', 'RSA PRIVATE', ' KEY-----');
    const end = join('-----END ', 'RSA PRIVATE', ' KEY-----');
    expect(r(`before\n${begin}\n${run(ALNUM, 64)}\n${run(ALNUM, 64)}\n${end}\nafter`)).toBe('before\n[redacted:private-key]\nafter');
    expect(r(`cut ${begin}\n${run(ALNUM, 64)}`)).toBe('cut [redacted:private-key]');
  });

  it('redact/jwt: a three-part token', () => {
    const jwt = [join('ey', 'J', run(ALNUM, 20)), join('ey', 'J', run(ALNUM, 30)), run(ALNUM, 43)].join('.');
    expect(r(`cookie ${jwt};`)).toBe('cookie [redacted:jwt];');
  });

  it('redact/bearer: the value after Bearer, the word kept', () => {
    expect(r(`curl -H "Authorization: Bearer ${run(ALNUM, 30)}" api`)).toBe('curl -H "Authorization: Bearer [redacted:bearer]" api');
  });

  it('redact/url-credentials: user and password in a URL', () => {
    expect(r(`clone https://deploy:${run(ALNUM, 12)}@git.shopfront.test/repo.git`)).toBe(
      'clone https://[redacted:url-credentials]@git.shopfront.test/repo.git',
    );
    expect(r('postgres://ledger:hunter2@db.ledger.test:5432/main')).toBe('postgres://[redacted:url-credentials]@db.ledger.test:5432/main');
  });

  it('redact/assignment-value: key, secret, token, password, passwd and authorization assignments', () => {
    expect(r(join('API_KEY', '=', 'shopfront-dev-1'))).toBe(`API_KEY=${M}`);
    expect(r(join('db_password', ' = ', '"hunter2hunter2"'))).toBe(`db_password = "${M}"`);
    expect(r(join('{"clientSecret"', ': ', '"abcdefgh12"}'))).toBe(`{"clientSecret": "${M}"}`);
    expect(r(join('  passwd', ': ', 'opensesame'))).toBe(`  passwd: ${M}`);
    expect(r(join('authorization', '=', 'Basic'))).toBe(`authorization=${M}`);
    // A token already redacted is not redacted twice.
    expect(r(join('GITHUB_TOKEN', '=', 'gh', 'p_', run(ALNUM, 36)))).toBe('GITHUB_TOKEN=[redacted:github-token]');
  });

  it('redact/home-prefix: the home directory becomes ~, a longer name is left alone', () => {
    expect(r(`open ${HOME}/projects/ledger/src/post.ts and ${HOME}`)).toBe('open ~/projects/ledger/src/post.ts and ~');
    expect(r('/Users/robinson/notes.md')).toBe('/Users/robinson/notes.md');
  });

  it('redact/high-entropy-next-to-keyword: hex and base64 runs of 40+ near a keyword', () => {
    const hex = run('0123456789abcdef', 40);
    const b64 = run(ALNUM + '+/', 44) + '==';
    expect(r(`the token is ${hex}`)).toBe('the token is [redacted:high-entropy]');
    expect(r(`${b64} was the secret`)).toBe('[redacted:high-entropy] was the secret');
    // Without a keyword nearby, a commit hash stays.
    expect(r(`commit ${hex} landed`)).toBe(`commit ${hex} landed`);
    // A run under 40 characters stays.
    expect(r(`token ${hex.slice(0, 39)}`)).toBe(`token ${hex.slice(0, 39)}`);
  });

  it('redact/plain-text-untouched: prose, code and paths without secrets', () => {
    const texts = [
      'Add a keyboard shortcut to the shopfront cart and refactor the token parser.',
      'The primary key of the ledger table is the entry id; use the password reset flow.',
      'Run npm test in acme-cli, then open src/core/session/redact-tokens.ts:42.',
      'git log --oneline 51515e4..HEAD',
      'const skipped = items.filter((item) => item.sk === "skip");',
      'see https://docs.shopfront.test/guide#setup',
    ];
    for (const text of texts) expect(r(text)).toBe(text);
  });
});
