// The redactor of ADR-038: applied to every string of a session digest before
// it is stored, and standalone so other text that leaves a process (ADR-032
// stderr) can reuse it. Matches become `[redacted:<kind>]`; the home directory
// prefix becomes `~`. It errs on the side of redacting: a false positive costs
// a word of a prompt, a false negative leaks a credential.

import { homedir } from 'node:os';

export type RedactionKind =
  | 'private-key'
  | 'jwt'
  | 'url-credentials'
  | 'github-token'
  | 'gitlab-token'
  | 'slack-token'
  | 'aws-key'
  | 'google-key'
  | 'api-key'
  | 'bearer'
  | 'secret'
  | 'high-entropy';

export interface RedactOptions {
  /** The home directory replaced by `~`; os.homedir() when omitted, nothing when null. */
  home?: string | null;
}

export type Redactor = (text: string) => string;

const mark = (kind: RedactionKind): string => `[redacted:${kind}]`;
const REDACTED_PREFIX = '[redacted:';

/** Characters of a token: a match must not start or end inside a longer run of them. */
const NOT_BEFORE = '(?<![A-Za-z0-9_-])';
const NOT_AFTER = '(?![A-Za-z0-9_-])';

/** Patterns replaced whole, in order: earlier kinds win over later ones. */
const WHOLE: ReadonlyArray<readonly [RedactionKind, RegExp]> = [
  // A block cut before its END line is redacted to the end of the text.
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['jwt', new RegExp(`${NOT_BEFORE}eyJ[A-Za-z0-9_-]{5,}\\.eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*`, 'g')],
  ['github-token', new RegExp(`${NOT_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})`, 'g')],
  ['gitlab-token', new RegExp(`${NOT_BEFORE}glpat-[A-Za-z0-9_-]{20,}`, 'g')],
  ['slack-token', new RegExp(`${NOT_BEFORE}xox[abposr]-[A-Za-z0-9-]{10,}`, 'g')],
  ['aws-key', new RegExp(`${NOT_BEFORE}(?:AKIA|ASIA)[0-9A-Z]{16}${NOT_AFTER}`, 'g')],
  ['google-key', new RegExp(`${NOT_BEFORE}AIza[0-9A-Za-z_-]{35}`, 'g')],
  // OpenAI and Anthropic style keys, the `sk-ant-` and `sk-proj-` forms included.
  ['api-key', new RegExp(`${NOT_BEFORE}sk-[A-Za-z0-9_-]{20,}`, 'g')],
];

/** `scheme://user:password@`: the user and the password go. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** `Bearer <value>`: the word stays, the value goes. */
const BEARER = /\b([Bb]earer)([ \t]+)[A-Za-z0-9._~+/=-]{12,}/g;

const KEYWORD = '(?:key|secret|token|password|passwd|authorization)';
/** A name that contains a keyword: `API_KEY`, `clientSecret`, `db_password`. */
const NAME = `[A-Za-z0-9_.-]*?${KEYWORD}[A-Za-z0-9_-]*`;
const QUOTED_VALUE = `(?:"([^"\\n]+)"|'([^'\\n]+)')`;

/** `name = value`, quoted or not; `==`, `!=`, `<=`, `>=` and `=>` are comparisons and arrows, not assignments. */
const ASSIGN_EQUALS = new RegExp(`(\\b${NAME}["']?[ \\t]*(?<![!<>=])=(?![=>])[ \\t]*)(?:${QUOTED_VALUE}|([^\\s"'\`,;]+))`, 'gi');
/** `"name": "value"` and `name: 'value'`: a colon needs a quoted value outside a line start. */
const ASSIGN_COLON_QUOTED = new RegExp(`(\\b${NAME}["']?[ \\t]*:[ \\t]*)${QUOTED_VALUE}`, 'gi');
/** `name: value` at the start of a line (YAML, headers, env dumps). */
const ASSIGN_COLON_LINE = new RegExp(`^([ \\t]*${NAME}[ \\t]*:[ \\t]+)([^\\s"'#]+)`, 'gim');

const RUN = '[A-Za-z0-9+/_-]{40,}={0,2}';
const RUN_START = '(?<![A-Za-z0-9+/=_-])';
const RUN_END = '(?![A-Za-z0-9+/=_-])';
/** A run of 40+ hex or base64 characters within 20 characters after a keyword... */
const ENTROPY_AFTER = new RegExp(`(${KEYWORD}[^\\n]{0,20}?)${RUN_START}(${RUN})${RUN_END}`, 'gi');
/** ...or before one. */
const ENTROPY_BEFORE = new RegExp(`${RUN_START}(${RUN})${RUN_END}([^\\n]{0,20}?${KEYWORD})`, 'gi');

/** A run that mixes digits and letters: words joined by `-` or `_` are not secrets. */
function looksRandom(run: string): boolean {
  return /[0-9]/.test(run) && /[A-Za-z]/.test(run);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactAssignmentValue(prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined): string {
  const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
  const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : '';
  if (value.startsWith(REDACTED_PREFIX)) return `${prefix}${quote}${value}${quote}`;
  return `${prefix}${quote}${mark('secret')}${quote}`;
}

/** A redactor bound to one home directory, its patterns compiled once. */
export function createRedactor(options: RedactOptions = {}): Redactor {
  const home = options.home === undefined ? homedir() : options.home;
  const homePattern =
    home !== null && home.length > 1 ? new RegExp(`${escapeRegExp(home.replace(/[/\\]+$/, ''))}(?![A-Za-z0-9._-])`, 'g') : null;

  return (text: string): string => {
    if (text.length === 0) return text;
    let out = text;
    for (const [kind, pattern] of WHOLE) out = out.replace(pattern, mark(kind));
    out = out.replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}${mark('url-credentials')}@`);
    out = out.replace(BEARER, (_match, word: string, space: string) => `${word}${space}${mark('bearer')}`);
    out = out.replace(ASSIGN_EQUALS, (_match, prefix: string, dq?: string, sq?: string, bare?: string) => redactAssignmentValue(prefix, dq, sq, bare));
    out = out.replace(ASSIGN_COLON_QUOTED, (_match, prefix: string, dq?: string, sq?: string) => redactAssignmentValue(prefix, dq, sq, undefined));
    out = out.replace(ASSIGN_COLON_LINE, (_match, prefix: string, bare: string) => redactAssignmentValue(prefix, undefined, undefined, bare));
    out = out.replace(ENTROPY_AFTER, (match, lead: string, run: string) => (looksRandom(run) ? `${lead}${mark('high-entropy')}` : match));
    out = out.replace(ENTROPY_BEFORE, (match, run: string, tail: string) => (looksRandom(run) ? `${mark('high-entropy')}${tail}` : match));
    if (homePattern !== null) out = out.replace(homePattern, '~');
    return out;
  };
}

/** `text` with every secret ADR-038 names replaced by `[redacted:<kind>]` and the home prefix by `~`. */
export function redact(text: string, options: RedactOptions = {}): string {
  return createRedactor(options)(text);
}
