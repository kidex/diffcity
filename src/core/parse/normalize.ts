import type { Node } from 'web-tree-sitter';

/** Comments that change tool behaviour and therefore count as code (ADR-005). */
const DIRECTIVE = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|prettier-ignore/;

/** Nodes compared by their exact source text: whitespace inside them is significant. */
const VERBATIM = new Set(['string', 'template_string', 'regex']);

export function isDirectiveComment(node: Node): boolean {
  return node.type === 'comment' && DIRECTIVE.test(node.text);
}

/**
 * JSX text as it renders: lines are trimmed at line breaks and blank lines
 * dropped, like the JSX transform does; spaces within a line are kept.
 */
function jsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      let out = line;
      if (i > 0) out = out.trimStart();
      if (i < last) out = out.trimEnd();
      return out;
    })
    .filter((line) => line.length > 0 && line.trim().length > 0)
    .join(' ');
}

function collect(node: Node, out: string[], skip: ReadonlySet<number>): void {
  if (skip.has(node.id)) return;
  if (node.type === 'comment') {
    if (isDirectiveComment(node)) out.push(node.text.trim());
    return;
  }
  if (VERBATIM.has(node.type)) {
    out.push(node.text);
    return;
  }
  if (node.type === 'jsx_text') {
    const text = jsxText(node.text);
    // Quoted so that a single rendered space stays distinguishable from the token separator.
    if (text.length > 0) out.push(JSON.stringify(text));
    return;
  }
  if (node.childCount === 0) {
    if (node.text.length > 0) out.push(node.text);
    return;
  }
  for (const child of node.children) collect(child, out, skip);
}

/**
 * ADR-005 normal form: the leaf tokens of the given nodes, in order, without
 * comments (directive comments kept), joined by a single space. Literals are
 * kept verbatim. Nodes whose id is in `skip` are left out with their subtree.
 */
export function normalize(nodes: readonly (Node | null | undefined)[], skip: ReadonlySet<number> = new Set()): string {
  const out: string[] = [];
  for (const node of nodes) if (node) collect(node, out, skip);
  return out.join(' ');
}
