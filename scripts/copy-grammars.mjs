#!/usr/bin/env node
// Copies the tree-sitter wasm grammars, their licenses and the highlights.scm
// queries from node_modules into grammars/, which ships in the npm package
// (ADR-013, ADR-027). The queries sit next to the wasm files as
// <package>.highlights.scm (and .highlights-jsx.scm for the JSX additions).
// Runs on `prepare`: after `npm install` / `npm ci` in the repo and before `npm pack`.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'grammars');
const require = createRequire(join(root, 'package.json'));

/** [package, files to copy as [source, target]] */
const grammars = [
  [
    'tree-sitter-typescript',
    [
      ['tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
      ['tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
      ['queries/highlights.scm', 'tree-sitter-typescript.highlights.scm'],
      ['LICENSE', 'LICENSE-tree-sitter-typescript'],
    ],
  ],
  [
    'tree-sitter-javascript',
    [
      ['tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
      ['queries/highlights.scm', 'tree-sitter-javascript.highlights.scm'],
      ['queries/highlights-jsx.scm', 'tree-sitter-javascript.highlights-jsx.scm'],
      ['LICENSE', 'LICENSE-tree-sitter-javascript'],
    ],
  ],
];

function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

mkdirSync(out, { recursive: true });
let failed = false;
for (const [pkg, files] of grammars) {
  const dir = packageDir(pkg);
  for (const [source, target] of files) {
    const dest = join(out, target);
    const src = dir === null ? null : join(dir, source);
    if (src !== null && existsSync(src)) {
      copyFileSync(src, dest);
    } else if (existsSync(dest)) {
      // Dev dependencies omitted (e.g. --omit=dev): keep the copy already in place.
      console.warn(`copy-grammars: ${pkg}/${source} not found, keeping existing grammars/${target}`);
    } else {
      console.error(`copy-grammars: ${pkg}/${source} not found; run npm install with dev dependencies`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
