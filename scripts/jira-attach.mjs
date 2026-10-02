// `node scripts/jira-attach.mjs <issue-key> <file>...`: uploads files (proof
// videos, say) as attachments of a Jira issue through the REST API
// (POST /rest/api/3/issue/{key}/attachments) and prints the id and name of
// each attachment created.
//
// Credentials, each from the environment first and the macOS Keychain second:
// - JIRA_API_TOKEN, else the password of the generic Keychain item with
//   service `diffcity-jira` and the account below;
// - JIRA_EMAIL, else the account (`acct`) of that Keychain item;
// - JIRA_BASE_URL (https://<site>), else the comment (`icmt`, set with -j) of
//   that Keychain item. No site is ever written in the repo.
//
// One-time setup (prompts for the token):
//   security add-generic-password -s diffcity-jira -a <email> -j <base-url> -w
//
// The token is never printed, logged or written anywhere; error messages have
// it removed. `security` runs through execFile, without a shell.
//
// Exit codes: 0 uploaded, 1 usage or upload error, 2 missing credentials.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KEYCHAIN_SERVICE = 'diffcity-jira';
export const SETUP_HINT =
  `missing Jira credentials: add them once with \`security add-generic-password -s ${KEYCHAIN_SERVICE} -a <email> -j <base-url> -w\` ` +
  '(or set JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL)';
const USAGE = 'usage: node scripts/jira-attach.mjs <issue-key> <file>...';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
// Jira refuses multipart uploads without this header (XSRF check).
const XSRF_HEADER = 'X-Atlassian-Token';
const XSRF_VALUE = 'no-check';

const CONTENT_TYPES = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png', '.txt': 'text/plain', '.md': 'text/markdown' };

/** Runs `security` with `args` and resolves with its stdout, or null when it fails (no item, no binary). */
export function runSecurity(args) {
  return new Promise((resolve) => {
    execFile('security', args, { encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/**
 * Parses `<issue-key> <file>...`. Returns `{ key, files }` or `{ error }`.
 * @param {string[]} args
 */
export function parseArgs(args) {
  if (args.includes('-h') || args.includes('--help')) return { error: USAGE };
  const [key, ...files] = args;
  if (key === undefined || files.length === 0) return { error: USAGE };
  if (!ISSUE_KEY.test(key)) return { error: `not an issue key: ${key} (expected PROJECT-123)` };
  const flag = files.find((file) => file.startsWith('-'));
  if (flag !== undefined) return { error: `unknown option: ${flag}\n${USAGE}` };
  return { key, files };
}

/**
 * The value of attribute `name` in the output of `security
 * find-generic-password` (without -g or -w, so no secret is in it): either
 * `"name"<blob>="text"` or, for bytes it does not print as text,
 * `"name"<blob>=0x<hex>  "..."`. Null when absent or <NULL>.
 * @param {string} listing
 * @param {string} name
 */
export function keychainAttribute(listing, name) {
  for (const line of listing.split('\n')) {
    const match = /^\s*"([a-z]{4})"<blob>=(.*)$/.exec(line);
    if (match === null || match[1] !== name) continue;
    const value = match[2]?.trim() ?? '';
    const hex = /^0x([0-9A-Fa-f]+)\b/.exec(value);
    if (hex !== null) return Buffer.from(hex[1] ?? '', 'hex').toString('utf8');
    const text = /^"(.*)"$/.exec(value);
    return text === null ? null : (text[1] ?? null);
  }
  return null;
}

/**
 * The email, token and base URL, from `env` first and the Keychain second.
 * Returns `{ email, token, baseUrl }`, or `{ error, code }`.
 * @param {Record<string, string | undefined>} env
 * @param {(args: string[]) => Promise<string | null>} security
 */
export async function resolveCredentials(env, security) {
  const nonEmpty = (value) => (value === undefined || value === null || value.trim() === '' ? undefined : value.trim());
  let email = nonEmpty(env.JIRA_EMAIL);
  let baseUrl = nonEmpty(env.JIRA_BASE_URL);
  let token = nonEmpty(env.JIRA_API_TOKEN);

  if (email === undefined || baseUrl === undefined) {
    const listing = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE]);
    if (listing !== null) {
      email ??= nonEmpty(keychainAttribute(listing, 'acct'));
      baseUrl ??= nonEmpty(keychainAttribute(listing, 'icmt'));
    }
  }
  if (token === undefined && email !== undefined) {
    const secret = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email, '-w']);
    if (secret !== null) token = nonEmpty(secret.replace(/\r?\n$/, ''));
  }
  if (email === undefined || token === undefined || baseUrl === undefined) return { error: SETUP_HINT, code: 2 };

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return { error: 'the Jira base URL is not a URL (expected https://<site>)', code: 2 };
  }
  if (url.protocol !== 'https:') return { error: 'the Jira base URL must use https', code: 2 };
  return { email, token, baseUrl: url.origin };
}

/** `text` with every occurrence of each of `secrets` replaced. */
export function redact(text, ...secrets) {
  let out = String(text);
  for (const value of secrets) {
    if (value !== undefined && value !== '') out = out.split(value).join('[redacted]');
  }
  return out;
}

/**
 * The script: `argv` without node and the script path. Everything with side
 * effects comes through `io` so tests run it with stubs.
 * @param {string[]} argv
 * @param {import('./jira-attach.d.mts').JiraAttachIo} io
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const doFetch = io.fetch ?? fetch;
  const security = io.security ?? runSecurity;
  const read = io.readFile ?? readFile;
  const isFile = io.isFile ?? ((path) => stat(path).then((info) => info.isFile(), () => false));
  const out = io.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.stderr ?? ((line) => process.stderr.write(`${line}\n`));

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    err(parsed.error);
    return 1;
  }
  for (const file of parsed.files) {
    if (!(await isFile(file))) {
      err(`not a file: ${file}`);
      return 1;
    }
  }

  const credentials = await resolveCredentials(env, security);
  if ('error' in credentials) {
    err(credentials.error);
    return credentials.code;
  }
  const { email, token, baseUrl } = credentials;
  const basic = Buffer.from(`${email}:${token}`).toString('base64');
  const clean = (text) => redact(text, token, basic);

  const form = new FormData();
  for (const file of parsed.files) {
    const name = basename(file);
    const dot = name.lastIndexOf('.');
    const type = (dot >= 0 ? CONTENT_TYPES[name.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream';
    form.append('file', new Blob([await read(file)], { type }), name);
  }

  const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(parsed.key)}/attachments`;
  let response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, [XSRF_HEADER]: XSRF_VALUE, Accept: 'application/json' },
      body: form,
      // A redirect would resend the Authorization header to wherever it points.
      redirect: 'error',
    });
  } catch (error) {
    err(clean(`upload to ${parsed.key} failed: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    // Redact first: a cut through the token would leave a fragment that redact no longer matches.
    const detail = clean(body).trim().slice(0, 500);
    err(clean(`upload to ${parsed.key} failed: HTTP ${String(response.status)}${detail === '' ? '' : `: ${detail}`}`));
    return 1;
  }

  let attachments;
  try {
    attachments = JSON.parse(body);
  } catch {
    attachments = null;
  }
  if (!Array.isArray(attachments)) {
    err(`uploaded to ${parsed.key}, but the answer was not a list of attachments`);
    return 1;
  }
  for (const attachment of attachments) {
    out(clean(`${String(attachment?.id ?? '?')}\t${String(attachment?.filename ?? '?')}`));
  }
  return 0;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = await main(process.argv.slice(2));
