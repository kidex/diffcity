import type { Node } from 'web-tree-sitter';
import { withDuplicateSuffixes } from './dedupe.js';
import { parserFor } from './grammars.js';
import type { TreeSitterLanguage } from './language.js';
import { isDirectiveComment, normalize } from './normalize.js';
import type { ParsedSymbol } from './types.js';

// Top-level symbol extraction for TypeScript, TSX and JavaScript (ADR-013),
// with signatures per ADR-006 and bodies in the ADR-005 normal form.
//
// The body is the normalized text of the whole declaration (name and
// signature included, JSDoc and plain comments excluded). Status compares the
// signature first, so a signature change is reported as `sig` either way, and
// every other non-whitespace, non-comment edit shows up as a body change.

type Kind = ParsedSymbol['kind'];

interface Candidate {
  name: string;
  kind: Kind;
  /** 1-based inclusive lines. */
  start: number;
  end: number;
  signature: string;
  body: string;
  signatureText: string;
  /** Methods, for classes. */
  members: Candidate[];
  /** Set on function-like candidates that take part in TypeScript overload groups. */
  overload?: 'signature' | 'implementation';
}

const FUNCTION_DECLARATIONS = new Set(['function_declaration', 'generator_function_declaration']);
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'generator_function']);
const CLASS_DECLARATIONS = new Set(['class_declaration', 'abstract_class_declaration']);
const VARIABLE_DECLARATIONS = new Set(['lexical_declaration', 'variable_declaration']);
const TYPE_DECLARATIONS = new Set(['interface_declaration', 'type_alias_declaration', 'enum_declaration']);
/** Modifiers that belong to a function or method signature (ADR-006). */
const SIGNATURE_MODIFIERS = new Set(['async', '*', 'static', 'abstract', 'accessibility_modifier']);
const TEST_FUNCTIONS = new Set(['describe', 'it', 'test']);

/**
 * Extracts the top-level symbols of a TypeScript, TSX or JavaScript source.
 * Never throws on syntax errors: the tree is parsed tolerantly and symbols
 * inside ERROR regions are skipped. Duplicate qualified names get `~2`, `~3`.
 */
export async function extractSymbols(source: string, language: TreeSitterLanguage): Promise<ParsedSymbol[]> {
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  if (tree === null) return [];
  try {
    return new Extractor(source).run(tree.rootNode);
  } finally {
    tree.delete();
  }
}

class Extractor {
  constructor(private readonly source: string) {}

  run(program: Node): ParsedSymbol[] {
    const candidates = mergeOverloads(program.namedChildren.flatMap((statement) => this.statement(statement)));
    // Top-level names are made unique first so each duplicate class gets its own
    // prefix (`Menu~2.render`). The final pass over the flattened list catches a
    // member colliding with a top-level name (`Cart.total` vs a test titled so).
    const topLevel = withDuplicateSuffixes(candidates.map((c) => c.name));
    const flat: [Candidate, string][] = candidates.flatMap((candidate, i) => {
      const qualifiedName = topLevel[i] ?? candidate.name;
      return [
        [candidate, qualifiedName] as [Candidate, string],
        ...candidate.members.map((member): [Candidate, string] => [member, `${qualifiedName}.${member.name}`]),
      ];
    });
    const unique = withDuplicateSuffixes(flat.map(([, name]) => name));
    return flat.map(([candidate, name], i) => toSymbol(candidate, unique[i] ?? name));
  }

  private statement(statement: Node): Candidate[] {
    switch (statement.type) {
      case 'export_statement':
        return this.exportStatement(statement);
      case 'function_declaration':
      case 'generator_function_declaration':
        return [this.functionDeclaration(statement, statement)];
      case 'function_signature':
        return [this.functionSignature(statement, statement)];
      case 'class_declaration':
      case 'abstract_class_declaration':
        return [this.classDeclaration(statement, statement)];
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.variables(statement, statement, false);
      case 'expression_statement': {
        const test = this.testBlock(statement);
        return test === null ? [] : [test];
      }
      default:
        // ERROR regions, imports, CommonJS assignments, blocks, namespaces, ambient declarations.
        return [];
    }
  }

  private exportStatement(statement: Node): Candidate[] {
    const declaration = statement.childForFieldName('declaration');
    if (declaration !== null) {
      if (FUNCTION_DECLARATIONS.has(declaration.type)) return [this.functionDeclaration(declaration, statement)];
      if (declaration.type === 'function_signature') return [this.functionSignature(declaration, statement)];
      if (CLASS_DECLARATIONS.has(declaration.type)) return [this.classDeclaration(declaration, statement)];
      if (VARIABLE_DECLARATIONS.has(declaration.type)) return this.variables(declaration, statement, true);
      if (TYPE_DECLARATIONS.has(declaration.type)) return [this.typeDeclaration(declaration, statement)];
      return [];
    }

    const value = statement.childForFieldName('value');
    if (value !== null) {
      if (value.type === 'class') return [this.classDeclaration(value, statement)];
      if (FUNCTION_VALUES.has(value.type)) {
        return [
          this.candidate('function', value.childForFieldName('name')?.text ?? 'default', statement, statement, {
            signature: functionSignature(value, [], null),
            body: normalize([...leadingDirectives(statement), value]),
            signatureText: this.head(statement, value.childForFieldName('body'), value),
          }),
        ];
      }
      return [
        this.candidate('export', 'default', statement, statement, {
          signature: '',
          body: normalize([...leadingDirectives(statement), statement]),
          signatureText: 'export default',
        }),
      ];
    }

    const source = statement.childForFieldName('source');
    const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
    if (clause !== undefined) {
      return clause.namedChildren
        .filter((specifier) => specifier.type === 'export_specifier')
        .map((specifier) => {
          const exported = specifier.childForFieldName('alias') ?? specifier.childForFieldName('name');
          return this.candidate('export', exported?.text ?? specifier.text, specifier, specifier, {
            signature: '',
            body: normalize([specifier, source]),
            signatureText: specifier.text,
          });
        });
    }

    const namespace = statement.namedChildren.find((child) => child.type === 'namespace_export');
    const star = statement.children.find((child) => child.type === '*');
    if (namespace !== undefined || star !== undefined) {
      const alias = namespace?.namedChildren.at(-1);
      const name = alias?.text ?? `* from ${source?.text ?? ''}`;
      return [
        this.candidate('export', name, statement, statement, {
          signature: '',
          body: normalize([...leadingDirectives(statement), statement]),
          signatureText: trimStatementEnd(statement.text),
        }),
      ];
    }
    return [];
  }

  private functionDeclaration(declaration: Node, outer: Node): Candidate {
    return {
      ...this.candidate('function', nameOf(declaration), outer, outer, {
        signature: functionSignature(declaration, [], null),
        body: normalize([...leadingDirectives(outer), declaration]),
        signatureText: this.head(outer, declaration.childForFieldName('body'), declaration),
      }),
      overload: 'implementation',
    };
  }

  private functionSignature(declaration: Node, outer: Node): Candidate {
    return {
      ...this.candidate('function', nameOf(declaration), outer, outer, {
        signature: functionSignature(declaration, [], null),
        body: normalize([...leadingDirectives(outer), declaration]),
        signatureText: this.head(outer, null, declaration),
      }),
      overload: 'signature',
    };
  }

  private classDeclaration(declaration: Node, outer: Node): Candidate {
    const decorators = [
      ...(outer === declaration ? [] : outer.children),
      ...declaration.children,
    ].filter((child) => child.type === 'decorator');
    const signature = normalize([
      ...decorators,
      ...declaration.children.filter((child) => child.type === 'abstract'),
      declaration.childForFieldName('type_parameters'),
      declaration.children.find((child) => child.type === 'class_heritage'),
    ]);
    const classBody = declaration.childForFieldName('body');
    const { members, skip } = classBody === null ? { members: [], skip: new Set<number>() } : this.members(classBody);
    return {
      ...this.candidate('class', declaration.childForFieldName('name')?.text ?? 'default', outer, outer, {
        signature,
        body: normalize([...leadingDirectives(outer), declaration], skip),
        signatureText: this.head(outer, classBody, declaration),
      }),
      members,
    };
  }

  private members(classBody: Node): { members: Candidate[]; skip: Set<number> } {
    const candidates: Candidate[] = [];
    const skip = new Set<number>();
    for (const member of classBody.namedChildren) {
      const candidate = this.member(member);
      if (candidate === null) continue;
      const attached = leadingAttachments(member);
      const terminator = trailingSemicolon(member);
      for (const node of [...attached, member, terminator]) if (node !== null) skip.add(node.id);
      candidates.push(candidate);
    }
    return { members: mergeOverloads(candidates), skip };
  }

  private member(member: Node): Candidate | null {
    const attached = leadingAttachments(member);
    const first = attached.find((node) => node.type === 'decorator') ?? member;
    const body = normalize([...attached, member, trailingSemicolon(member)]);
    const textStart = member.children.find((child) => child.type !== 'decorator' && child.type !== 'comment') ?? member;

    switch (member.type) {
      case 'method_definition':
        return {
          ...this.candidate('method', methodName(member), first, member, {
            signature: functionSignature(member, [], null),
            body,
            signatureText: this.head(textStart, member.childForFieldName('body'), member),
          }),
          overload: 'implementation',
        };
      case 'method_signature':
      case 'abstract_method_signature':
        return {
          ...this.candidate('method', methodName(member), first, member, {
            signature: functionSignature(member, [], null),
            body,
            signatureText: this.head(textStart, null, member),
          }),
          overload: 'signature',
        };
      case 'public_field_definition':
      case 'field_definition': {
        const value = member.childForFieldName('value');
        const nameNode = member.childForFieldName('name') ?? member.childForFieldName('property');
        if (value === null || nameNode === null || !FUNCTION_VALUES.has(value.type)) return null;
        const holderModifiers = member.children.filter(
          (child) => child.startIndex < value.startIndex && SIGNATURE_MODIFIERS.has(child.type),
        );
        return this.candidate('method', nameNode.text, first, member, {
          signature: functionSignature(value, holderModifiers, member.childForFieldName('type')),
          body,
          signatureText: this.head(textStart, value.childForFieldName('body'), member),
        });
      }
      default:
        return null;
    }
  }

  private variables(declaration: Node, outer: Node, exported: boolean): Candidate[] {
    const declarators = declaration.namedChildren.filter((child) => child.type === 'variable_declarator');
    const single = declarators.length === 1;
    const directives = leadingDirectives(outer);
    // `const` / `let` / `var` and the statement's closing `;`, when present.
    const keyword = declaration.children[0] ?? null;
    const semicolon = declaration.children.find((child) => child.type === ';') ?? null;
    const out: Candidate[] = [];
    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName('name');
      // Destructuring patterns do not name a single symbol.
      if (nameNode?.type !== 'identifier') continue;
      const value = declarator.childForFieldName('value');
      const type = declarator.childForFieldName('type');
      const rangeNode = single ? outer : declarator;
      if (value !== null && FUNCTION_VALUES.has(value.type)) {
        out.push(
          this.candidate('function', nameNode.text, rangeNode, rangeNode, {
            signature: functionSignature(value, [], type),
            // Keyword, own declarator and closing `;` (ADR-005: they are tokens);
            // sibling declarators and the commas between them stay out.
            body: normalize([...directives, keyword, declarator, semicolon]),
            signatureText: this.head(rangeNode, value.childForFieldName('body'), value),
          }),
        );
      } else if (exported) {
        out.push(
          this.candidate('export', nameNode.text, rangeNode, rangeNode, {
            // ADR-006: the type annotation is the signature, the initializer is the body.
            signature: normalize([type]),
            body: normalize([...directives, value]),
            signatureText: this.source.slice(declarator.startIndex, (type ?? nameNode).endIndex),
          }),
        );
      }
    }
    return out;
  }

  private typeDeclaration(declaration: Node, outer: Node): Candidate {
    const nameNode = declaration.childForFieldName('name');
    const typeParameters = declaration.childForFieldName('type_parameters');
    return this.candidate('export', nameNode?.text ?? 'default', outer, outer, {
      signature: normalize([typeParameters]),
      body: normalize([...leadingDirectives(outer), declaration]),
      signatureText: this.source.slice(outer.startIndex, (typeParameters ?? nameNode ?? declaration).endIndex),
    });
  }

  /** Top-level `describe` / `it` / `test` call (also `.skip`, `.only`, ...) with a literal title. */
  private testBlock(statement: Node): Candidate | null {
    const call = statement.namedChildren[0];
    if (call?.type !== 'call_expression') return null;
    const callee = call.childForFieldName('function');
    if (callee === null || !isTestCallee(callee)) return null;
    const title = call.childForFieldName('arguments')?.namedChildren.find((arg) => arg.type !== 'comment');
    const name = title === undefined ? null : literalText(title);
    if (title === undefined || name === null) return null;
    return this.candidate('function', name, statement, statement, {
      signature: '',
      body: normalize([...leadingDirectives(statement), statement]),
      signatureText: `${callee.text}(${title.text})`,
    });
  }

  private candidate(
    kind: Kind,
    name: string,
    first: Node,
    last: Node,
    parts: Pick<Candidate, 'signature' | 'body' | 'signatureText'>,
  ): Candidate {
    return {
      name,
      kind,
      start: first.startPosition.row + 1,
      end: last.endPosition.row + 1,
      ...parts,
      members: [],
    };
  }

  /** Source text of a declaration head: from `start` up to its body, or to the end of `whole` when there is none. */
  private head(start: Node, body: Node | null, whole: Node): string {
    return trimStatementEnd(this.source.slice(start.startIndex, body?.startIndex ?? whole.endIndex));
  }
}

function toSymbol(candidate: Candidate, qualifiedName: string): ParsedSymbol {
  return {
    name: candidate.name,
    qualifiedName,
    kind: candidate.kind,
    range: { start: candidate.start, end: candidate.end },
    signature: candidate.signature,
    body: candidate.body,
    signatureText: candidate.signatureText,
  };
}

/**
 * ADR-006 signature of a function-like node: signature modifiers, the declared
 * type of the binding (for `const f: T = () => ...`), type parameters,
 * parameters as written and the explicit return type. A bare arrow parameter
 * is written as `( x )` so that adding parentheses is not a change.
 */
function functionSignature(fn: Node, holderModifiers: readonly Node[], declaredType: Node | null): string {
  const parameters = fn.childForFieldName('parameters');
  const bare = parameters === null ? fn.childForFieldName('parameter') : null;
  const paramStart = (parameters ?? bare)?.startIndex ?? fn.endIndex;
  const modifiers = fn.children.filter((child) => child.startIndex < paramStart && SIGNATURE_MODIFIERS.has(child.type));
  const parts = [
    normalize([...holderModifiers, ...modifiers]),
    normalize([declaredType]),
    normalize([fn.childForFieldName('type_parameters')]),
    bare === null ? normalize([parameters]) : `( ${normalize([bare])} )`,
    normalize([fn.childForFieldName('return_type')]),
  ];
  return parts.filter((part) => part.length > 0).join(' ');
}

/**
 * Folds TypeScript overload groups into one candidate: consecutive signatures
 * with the same name, optionally followed by the implementation. The
 * signature lists every overload in order, then the implementation's (ADR-006).
 */
function mergeOverloads(candidates: readonly Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  let group: Candidate[] = [];
  const flush = (): void => {
    const [first] = group;
    const last = group.at(-1);
    if (first !== undefined && last !== undefined) {
      const implementation = last.overload === 'implementation' ? last : null;
      out.push({
        ...first,
        end: last.end,
        signature: group.map((c) => c.signature).join('\n'),
        signatureText: group.map((c) => c.signatureText).join('\n'),
        body: implementation?.body ?? group.map((c) => c.body).join('\n'),
      });
    }
    group = [];
  };
  for (const candidate of candidates) {
    const sameGroup = group.length > 0 && group[0]?.name === candidate.name;
    if (candidate.overload === 'signature') {
      if (!sameGroup) flush();
      group.push(candidate);
    } else if (candidate.overload === 'implementation' && sameGroup) {
      group.push(candidate);
      flush();
    } else {
      flush();
      out.push(candidate);
    }
  }
  flush();
  return out.map((candidate) => {
    const plain = { ...candidate };
    delete plain.overload;
    return plain;
  });
}

function nameOf(declaration: Node): string {
  return declaration.childForFieldName('name')?.text ?? 'default';
}

/** `name`, or `get name` / `set name` for accessors (ADR-013). */
function methodName(member: Node): string {
  const name = member.childForFieldName('name')?.text ?? '';
  const accessor = member.children.find((child) => child.type === 'get' || child.type === 'set');
  return accessor === undefined ? name : `${accessor.type} ${name}`;
}

function isTestCallee(node: Node): boolean {
  if (node.type === 'identifier') return TEST_FUNCTIONS.has(node.text);
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    return node.childForFieldName('property')?.type === 'property_identifier' && object !== null && isTestCallee(object);
  }
  return false;
}

/** The text of a string literal or a template literal without substitutions, else `null`. */
function literalText(node: Node): string | null {
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string' && !node.namedChildren.some((child) => child.type === 'template_substitution')) {
    return node.text.slice(1, -1);
  }
  return null;
}

/**
 * Decorators and comments directly above a node (siblings, no code between).
 * A comment that trails code on the previous line's end stays with that code.
 */
function leadingAttachments(node: Node): Node[] {
  const attached: Node[] = [];
  let previous = node.previousSibling;
  while (previous !== null && (previous.type === 'comment' || previous.type === 'decorator')) {
    if (previous.type === 'comment') {
      const beforeComment = previous.previousSibling;
      const trailing =
        beforeComment !== null &&
        beforeComment.type !== 'comment' &&
        beforeComment.type !== 'decorator' &&
        beforeComment.endPosition.row === previous.startPosition.row;
      if (trailing) break;
    }
    attached.unshift(previous);
    previous = previous.previousSibling;
  }
  return attached;
}

/** The `;` after a class member: a sibling in the class body, but part of the member. */
function trailingSemicolon(member: Node): Node | null {
  const next = member.nextSibling;
  return next?.type === ';' ? next : null;
}

function leadingDirectives(node: Node): Node[] {
  return leadingAttachments(node).filter(isDirectiveComment);
}

function trimStatementEnd(text: string): string {
  return text.trimEnd().replace(/;$/, '').trimEnd();
}
