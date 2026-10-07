import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import { parserFor } from '../parse/grammars.js';
import type { TreeSitterLanguage } from '../parse/language.js';

// The syntax facts entry points are classified from (ADR-034, SPEC.md 5.4):
// HTTP route registrations, NestJS and Next.js routes, commander actions,
// scheduled jobs and test blocks, found with tree-sitter in one version of a
// file. Pure over the source; the only I/O is loading the grammar. Which
// symbol a fact makes an entry is decided in order.ts, which sees every file.

/** A handler passed by name: an identifier, or the property of a member (`ctrl.list`). */
export interface HandlerRef {
  name: string;
  /** 1-based line of the reference. */
  line: number;
}

/** One HTTP route: `<METHOD> <path>` and where it is declared. */
export interface RouteFact {
  /** Upper case: GET, POST, ..., USE, ALL. */
  method: string;
  path: string;
  /** 1-based line inside the declaring symbol (the registration call, the decorated method, the exported handler). */
  line: number;
  /** Handlers passed by name; empty for an inline function or a decorated method. */
  handlers: HandlerRef[];
}

/** A commander `.action(handler)` or a scheduled job: the handler by name, or the line of the call for an inline one. */
export interface CallbackFact {
  line: number;
  handlers: HandlerRef[];
}

export interface EntryFacts {
  /** Relative module specifiers the file imports or re-exports (handler names resolve through them). */
  imports: string[];
  /** Express-style registrations, NestJS controller methods and Next.js route handlers, in source order. */
  routes: RouteFact[];
  /** Commander `.action(...)` callbacks. */
  actions: CallbackFact[];
  /** `cron.schedule(...)`, `schedule.scheduleJob(...)` and `@Cron(...)` methods. */
  jobs: CallbackFact[];
  /** Start lines of top-level `describe` / `it` / `test` blocks. */
  testBlocks: number[];
}

/** `<object>.<method>(...)` receivers that register HTTP routes (ADR-034). */
const ROUTER_OBJECTS = new Set(['app', 'router', 'server', 'fastify', 'api']);
const ROUTER_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
/** NestJS method decorators (ADR-034). */
const NEST_METHODS: Readonly<Record<string, string>> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE' };
/** Next.js route handler exports. */
export const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const TEST_CALLEES = new Set(['describe', 'it', 'test']);
const FUNCTIONS = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

/** Whether `path` is a test file: `*.test.*`, `*.spec.*` or under `__tests__/`. */
export function isTestFile(path: string): boolean {
  const base = posix.basename(path);
  return /\.(?:test|spec)\./.test(base) || path.split('/').slice(0, -1).includes('__tests__');
}

/** Whether `path` is a Next.js route handler file (`route.ts`, `route.js`, ...). */
export function isNextRouteFile(path: string): boolean {
  return /^route\.(?:[cm]?[jt]s|[jt]sx)$/.test(posix.basename(path));
}

/**
 * The URL path of a Next.js route file: its directory below the last `app`
 * segment, without route groups `(name)` and parallel slots `@name`.
 */
export function nextRoutePath(path: string): string {
  const dirs = posix.dirname(path).split('/').filter((segment) => segment !== '.' && segment !== '');
  const app = dirs.lastIndexOf('app');
  const below = (app === -1 ? dirs : dirs.slice(app + 1)).filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith('@'));
  return `/${below.join('/')}`;
}

function joinUrl(...parts: string[]): string {
  const segments = parts.flatMap((part) => part.split('/')).filter((segment) => segment !== '');
  return `/${segments.join('/')}`;
}

/** The value of a plain string literal node, `null` for anything else (a template with substitutions too). */
function stringOf(node: Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  const text = node.text;
  if (node.type === 'template_string' && text.includes('${')) return null;
  return text.length >= 2 ? text.slice(1, -1) : null;
}

const line = (node: Node): number => node.startPosition.row + 1;

function handlerRef(node: Node): HandlerRef | null {
  if (node.type === 'identifier') return { name: node.text, line: line(node) };
  if (node.type === 'member_expression') {
    const property = node.childForFieldName('property');
    return property === null ? null : { name: property.text, line: line(node) };
  }
  return null;
}

/** The decorator's callee name and its first argument when it is a string. */
function decoratorCall(decorator: Node): { name: string; argument: string | null } | null {
  const expression = decorator.namedChildren[0];
  if (expression === undefined) return null;
  if (expression.type === 'identifier') return { name: expression.text, argument: null };
  if (expression.type !== 'call_expression') return null;
  const callee = expression.childForFieldName('function');
  if (callee?.type !== 'identifier') return null;
  const first = expression.childForFieldName('arguments')?.namedChildren.find((arg) => arg.type !== 'comment');
  return { name: callee.text, argument: stringOf(first) };
}

/** The root identifier of a callee chain such as `describe.skip` or `it.each([...])`. */
function chainRoot(node: Node | null): Node | null {
  let current = node;
  while (current !== null) {
    if (current.type === 'member_expression') current = current.childForFieldName('object');
    else if (current.type === 'call_expression') current = current.childForFieldName('function');
    else return current;
  }
  return null;
}

/** Whether the receiver chain of `.action(...)` is a commander command: it goes through `.command(...)` or starts at `program`. */
function isCommanderChain(receiver: Node | null): boolean {
  let current = receiver;
  while (current !== null) {
    if (current.type === 'call_expression') {
      const callee = current.childForFieldName('function');
      if (callee?.type === 'member_expression' && callee.childForFieldName('property')?.text === 'command') return true;
      current = callee;
    } else if (current.type === 'member_expression') {
      current = current.childForFieldName('object');
    } else {
      return current.type === 'identifier' && current.text === 'program';
    }
  }
  return false;
}

class Scanner {
  readonly facts: EntryFacts = { imports: [], routes: [], actions: [], jobs: [], testBlocks: [] };
  private readonly imports = new Set<string>();

  constructor(private readonly path: string) {}

  run(root: Node): EntryFacts {
    for (const statement of root.namedChildren) this.topLevel(statement);
    const nodes = root.descendantsOfType(['call_expression', 'class_declaration', 'abstract_class_declaration', 'class']);
    for (const node of nodes) {
      if (node.type === 'call_expression') this.call(node);
      else this.classNode(node);
    }
    this.facts.imports = [...this.imports].sort();
    this.facts.routes.sort((a, b) => a.line - b.line);
    this.facts.actions.sort((a, b) => a.line - b.line);
    this.facts.jobs.sort((a, b) => a.line - b.line);
    return this.facts;
  }

  private topLevel(statement: Node): void {
    if (statement.type === 'import_statement' || statement.type === 'export_statement') {
      const source = stringOf(statement.childForFieldName('source'));
      if (source !== null && (source.startsWith('./') || source.startsWith('../'))) this.imports.add(source);
    }
    if (statement.type === 'export_statement' && isNextRouteFile(this.path)) this.nextExport(statement);
    if (statement.type === 'expression_statement') {
      const call = statement.namedChildren[0];
      if (call?.type !== 'call_expression') return;
      const root = chainRoot(call.childForFieldName('function'));
      if (root?.type === 'identifier' && TEST_CALLEES.has(root.text)) this.facts.testBlocks.push(line(statement));
    }
  }

  private nextExport(statement: Node): void {
    const declaration = statement.childForFieldName('declaration');
    if (declaration === null) return;
    const names: Node[] = [];
    if (declaration.type === 'function_declaration' || declaration.type === 'generator_function_declaration') {
      const name = declaration.childForFieldName('name');
      if (name !== null) names.push(name);
    } else if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
      for (const declarator of declaration.namedChildren.filter((child) => child.type === 'variable_declarator')) {
        const name = declarator.childForFieldName('name');
        if (name?.type === 'identifier') names.push(name);
      }
    }
    for (const name of names) {
      if (NEXT_METHODS.has(name.text)) {
        this.facts.routes.push({ method: name.text, path: nextRoutePath(this.path), line: line(name), handlers: [] });
      }
    }
  }

  private call(node: Node): void {
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'member_expression') return;
    const object = callee.childForFieldName('object');
    const property = callee.childForFieldName('property')?.text ?? '';
    const args = (node.childForFieldName('arguments')?.namedChildren ?? []).filter((arg) => arg.type !== 'comment');

    if (object?.type === 'identifier' && ROUTER_OBJECTS.has(object.text) && ROUTER_METHODS.has(property)) {
      const path = stringOf(args[0]);
      if (path === null) return;
      const handlers = args.slice(1).flatMap((arg) => handlerRef(arg) ?? []);
      this.facts.routes.push({ method: property.toUpperCase(), path, line: line(node), handlers });
      return;
    }
    if (property === 'action' && isCommanderChain(object)) {
      const handler = args[0];
      if (handler === undefined) return;
      const ref = handlerRef(handler);
      if (ref !== null || FUNCTIONS.has(handler.type)) this.facts.actions.push({ line: line(node), handlers: ref === null ? [] : [ref] });
      return;
    }
    const isCron = object?.type === 'identifier' && object.text === 'cron' && property === 'schedule';
    const isScheduleJob = object?.type === 'identifier' && object.text === 'schedule' && property === 'scheduleJob';
    if (isCron || isScheduleJob) {
      this.facts.jobs.push({ line: line(node), handlers: args.slice(1).flatMap((arg) => handlerRef(arg) ?? []) });
    }
  }

  /** NestJS controllers and `@Cron(...)` methods. */
  private classNode(node: Node): void {
    const outer = node.parent?.type === 'export_statement' ? node.parent : null;
    const classDecorators = [...(outer?.children ?? []), ...node.children]
      .filter((child) => child.type === 'decorator')
      .flatMap((decorator) => decoratorCall(decorator) ?? []);
    const controller = classDecorators.find((decorator) => decorator.name === 'Controller');
    const body = node.childForFieldName('body');
    if (body === null) return;
    let pending: { name: string; argument: string | null }[] = [];
    for (const member of body.namedChildren) {
      if (member.type === 'decorator') {
        const call = decoratorCall(member);
        if (call !== null) pending.push(call);
        continue;
      }
      if (member.type === 'comment') continue;
      const decorators = [
        ...pending,
        ...member.children.filter((child) => child.type === 'decorator').flatMap((decorator) => decoratorCall(decorator) ?? []),
      ];
      pending = [];
      if (member.type !== 'method_definition') continue;
      const at = line(member.childForFieldName('name') ?? member);
      for (const decorator of decorators) {
        const method = NEST_METHODS[decorator.name];
        if (controller !== undefined && method !== undefined) {
          this.facts.routes.push({ method, path: joinUrl(controller.argument ?? '', decorator.argument ?? ''), line: at, handlers: [] });
        }
        if (decorator.name === 'Cron') this.facts.jobs.push({ line: at, handlers: [] });
      }
    }
  }
}

/**
 * Whether an untouched file may register a route, a commander action or a
 * scheduled job for a touched handler: a cheap text test that spares parsing
 * the rest of the repo's untouched files a second time.
 */
export function mayRegisterEntries(source: string): boolean {
  return (
    /\b(?:app|router|server|fastify|api)\s*\.\s*(?:get|post|put|patch|delete|all|use)\s*\(/.test(source) ||
    /\.\s*action\s*\(/.test(source) ||
    /\bcron\s*\.\s*schedule\s*\(|\bschedule\s*\.\s*scheduleJob\s*\(/.test(source)
  );
}

/** The entry-point facts of one version of a TS, TSX or JS file. */
export async function scanEntryFacts(source: string, language: TreeSitterLanguage, path: string): Promise<EntryFacts> {
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  if (tree === null) return { imports: [], routes: [], actions: [], jobs: [], testBlocks: [] };
  try {
    return new Scanner(path).run(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/** `<METHOD> <path>`: what tells a new route from one that existed before. */
export const routeKey = (route: Pick<RouteFact, 'method' | 'path'>): string => `${route.method} ${route.path}`;
