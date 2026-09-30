import type { ParsedSymbol } from './types.js';

/**
 * SQL symbol extraction (ADR-013): every statement of a .sql file is one
 * `sql` symbol. Statements are split on `;` outside string literals, quoted
 * identifiers, comments and dollar-quoted blocks. The body is the statement's
 * tokens joined by a single space, so comments and whitespace outside literals
 * never change it (ADR-005). SQL has no signature (ADR-006).
 */

type TokenType = 'word' | 'ident' | 'string' | 'dollar' | 'param' | 'number' | 'punct' | 'semi';

interface Token {
  type: TokenType;
  text: string;
  start: number;
  /** Offset one past the last character. */
  end: number;
}

const WHITESPACE = /\s+/y;
const LINE_COMMENT = /--[^\n]*/y;
const ESCAPE_STRING = /[eE]'(?:[^'\\]|\\[\s\S]|'')*'?/y;
const PREFIXED_STRING = /(?:[nNbBxX]|[uU]&)'(?:[^']|'')*'?/y;
const UNICODE_IDENT = /[uU]&"(?:[^"]|"")*"?/y;
const WORD = /[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/y;
const QUOTED_IDENT = /"(?:[^"]|"")*"?/y;
const BACKTICK_IDENT = /`[^`]*`?/y;
const STRING = /'(?:[^']|'')*'?/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;
const PARAM = /\$\d+/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function matchAt(re: RegExp, source: string, pos: number): string | null {
  re.lastIndex = pos;
  const m = re.exec(source);
  return m ? m[0] : null;
}

/** Length of a (possibly nested, possibly unterminated) block comment at `pos`. */
function blockCommentEnd(source: string, pos: number): number {
  let depth = 0;
  let i = pos;
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (source.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return source.length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const push = (type: TokenType, end: number): void => {
    tokens.push({ type, text: source.slice(pos, end), start: pos, end });
    pos = end;
  };

  while (pos < source.length) {
    const ws = matchAt(WHITESPACE, source, pos);
    if (ws !== null) {
      pos += ws.length;
      continue;
    }
    const lineComment = matchAt(LINE_COMMENT, source, pos);
    if (lineComment !== null) {
      pos += lineComment.length;
      continue;
    }
    if (source.startsWith('/*', pos)) {
      pos = blockCommentEnd(source, pos);
      continue;
    }

    const stringLike =
      matchAt(ESCAPE_STRING, source, pos) ?? matchAt(PREFIXED_STRING, source, pos);
    if (stringLike !== null) {
      push('string', pos + stringLike.length);
      continue;
    }
    const identLike =
      matchAt(UNICODE_IDENT, source, pos) ??
      matchAt(QUOTED_IDENT, source, pos) ??
      matchAt(BACKTICK_IDENT, source, pos);
    if (identLike !== null) {
      push('ident', pos + identLike.length);
      continue;
    }
    const word = matchAt(WORD, source, pos);
    if (word !== null) {
      push('word', pos + word.length);
      continue;
    }
    const str = matchAt(STRING, source, pos);
    if (str !== null) {
      push('string', pos + str.length);
      continue;
    }
    const tag = matchAt(DOLLAR_TAG, source, pos);
    if (tag !== null) {
      const close = source.indexOf(tag, pos + tag.length);
      push('dollar', close === -1 ? source.length : close + tag.length);
      continue;
    }
    const param = matchAt(PARAM, source, pos);
    if (param !== null) {
      push('param', pos + param.length);
      continue;
    }
    const num = matchAt(NUMBER, source, pos);
    if (num !== null) {
      push('number', pos + num.length);
      continue;
    }
    // A single character keeps the normalized form independent of spacing
    // around operators and punctuation. Code points are kept whole.
    const cp = source.codePointAt(pos) ?? 0;
    push(source[pos] === ';' ? 'semi' : 'punct', pos + (cp > 0xffff ? 2 : 1));
  }
  return tokens;
}

function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    current.push(token);
    if (token.type === 'semi') {
      statements.push(current);
      current = [];
    }
  }
  if (current.length > 0) statements.push(current);
  return statements.filter((s) => s.some((t) => t.type !== 'semi'));
}

/** Object types that can follow CREATE / ALTER / DROP / COMMENT ON, longest first. */
const OBJECT_TYPES: string[][] = [
  ['TEXT', 'SEARCH', 'CONFIGURATION'],
  ['TEXT', 'SEARCH', 'DICTIONARY'],
  ['TEXT', 'SEARCH', 'PARSER'],
  ['TEXT', 'SEARCH', 'TEMPLATE'],
  ['FOREIGN', 'DATA', 'WRAPPER'],
  ['MATERIALIZED', 'VIEW'],
  ['FOREIGN', 'TABLE'],
  ['EVENT', 'TRIGGER'],
  ['CONSTRAINT', 'TRIGGER'],
  ['ACCESS', 'METHOD'],
  ['OPERATOR', 'CLASS'],
  ['OPERATOR', 'FAMILY'],
  ['TABLE'],
  ['INDEX'],
  ['VIEW'],
  ['FUNCTION'],
  ['PROCEDURE'],
  ['ROUTINE'],
  ['TRIGGER'],
  ['SEQUENCE'],
  ['SCHEMA'],
  ['TYPE'],
  ['DOMAIN'],
  ['EXTENSION'],
  ['POLICY'],
  ['ROLE'],
  ['USER'],
  ['GROUP'],
  ['DATABASE'],
  ['AGGREGATE'],
  ['OPERATOR'],
  ['RULE'],
  ['COLLATION'],
  ['CONVERSION'],
  ['LANGUAGE'],
  ['PUBLICATION'],
  ['SUBSCRIPTION'],
  ['TABLESPACE'],
  ['SERVER'],
  ['STATISTICS'],
  ['COLUMN'],
  ['CONSTRAINT'],
];

/** Words between CREATE and the object type that do not identify the object. */
const CREATE_MODIFIERS = new Set([
  'OR',
  'REPLACE',
  'TEMP',
  'TEMPORARY',
  'GLOBAL',
  'LOCAL',
  'UNLOGGED',
  'UNIQUE',
  'RECURSIVE',
  'TRUSTED',
  'PROCEDURAL',
  'DEFAULT',
]);

/** Words between the object type (or verb) and the object name. */
const NAME_MODIFIERS: string[][] = [['IF', 'NOT', 'EXISTS'], ['IF', 'EXISTS'], ['CONCURRENTLY'], ['ONLY']];

class Cursor {
  constructor(
    private readonly tokens: Token[],
    public index = 0,
  ) {}

  word(offset = 0): string | null {
    const t = this.tokens[this.index + offset];
    return t?.type === 'word' ? t.text.toUpperCase() : null;
  }

  /** Consumes the keyword sequence if it is next. */
  accept(words: string[]): boolean {
    if (!words.every((w, k) => this.word(k) === w)) return false;
    this.index += words.length;
    return true;
  }

  skipNameModifiers(): void {
    while (NAME_MODIFIERS.some((m) => this.accept(m))) {
      // keep skipping
    }
  }

  objectType(): string[] | null {
    return OBJECT_TYPES.find((t) => this.accept(t)) ?? null;
  }

  /** A possibly schema-qualified name as written, e.g. `pastry."Daily Totals"`. */
  qualifiedName(): string | null {
    const isName = (t: Token | undefined): t is Token => t?.type === 'word' || t?.type === 'ident';
    const first = this.tokens[this.index];
    if (!isName(first)) return null;
    let name = first.text;
    this.index++;
    for (;;) {
      const dot = this.tokens[this.index];
      const next = this.tokens[this.index + 1];
      if (dot?.type !== 'punct' || dot.text !== '.' || !isName(next)) break;
      name += `.${next.text}`;
      this.index += 2;
    }
    return name;
  }

  /** Name after the object type; `ON <table>` for unnamed indexes. */
  objectName(): string | null {
    this.skipNameModifiers();
    if (this.accept(['ON'])) {
      this.skipNameModifiers();
      const table = this.qualifiedName();
      return table === null ? null : `ON ${table}`;
    }
    return this.qualifiedName();
  }
}

function join(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => p !== null && p !== '').join(' ');
}

/** Fallback: the leading keywords, at most two. */
function fallbackName(tokens: Token[]): string {
  const words: string[] = [];
  for (const t of tokens) {
    if (t.type !== 'word' || words.length === 2) break;
    words.push(t.text.toUpperCase());
  }
  return words.length > 0 ? words.join(' ') : (tokens[0]?.text ?? '');
}

function statementName(tokens: Token[]): string {
  const c = new Cursor(tokens);
  const verb = c.word();
  if (verb === null) return fallbackName(tokens);
  c.index = 1;

  switch (verb) {
    case 'CREATE':
    case 'ALTER':
    case 'DROP':
    case 'REFRESH': {
      if (verb === 'CREATE') {
        while (CREATE_MODIFIERS.has(c.word() ?? '')) c.index++;
      }
      const type = c.objectType();
      if (type === null) return fallbackName(tokens);
      return join(verb, type.join(' '), c.objectName());
    }
    case 'COMMENT': {
      if (!c.accept(['ON'])) return fallbackName(tokens);
      const type = c.objectType();
      if (type === null) return fallbackName(tokens);
      return join('COMMENT ON', type.join(' '), c.qualifiedName());
    }
    case 'INSERT':
    case 'MERGE':
      if (!c.accept(['INTO'])) return fallbackName(tokens);
      return join(verb, 'INTO', c.objectName());
    case 'DELETE':
      if (!c.accept(['FROM'])) return fallbackName(tokens);
      return join(verb, 'FROM', c.objectName());
    case 'UPDATE':
    case 'COPY':
      return join(verb, c.objectName());
    case 'TRUNCATE':
      c.accept(['TABLE']);
      return join(verb, c.objectName());
    default:
      return fallbackName(tokens);
  }
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line of the character at `offset`. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function extractSqlSymbols(source: string): ParsedSymbol[] {
  const starts = lineStarts(source);
  const seen = new Map<string, number>();
  const symbols: ParsedSymbol[] = [];

  for (const statement of splitStatements(tokenize(source))) {
    const first = statement[0];
    const last = statement[statement.length - 1];
    if (first === undefined || last === undefined) continue;

    const base = statementName(statement);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const name = count === 1 ? base : `${base}~${String(count)}`;

    symbols.push({
      name,
      qualifiedName: name,
      kind: 'sql',
      range: { start: lineOf(starts, first.start), end: lineOf(starts, last.end - 1) },
      signature: '',
      body: statement.map((t) => t.text).join(' '),
      signatureText: '',
    });
  }
  return symbols;
}
