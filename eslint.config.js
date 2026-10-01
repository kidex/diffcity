import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Import boundaries between layers (SPEC.md section 10, ADR-002, ADR-022).
// A pattern matches the import specifier: a relative path that walks into one of
// `dirs`, or any specifier that goes through src/<dir>.
const into = (dirs) => String.raw`^(?:\.{1,2}/(?:.*/)?|(?:.*/)?src/)(?:${dirs})(?:/|$)`;

// The same pattern inside an esquery selector, where `/` closes the regex.
const inSelector = (regex) => `/${regex.replaceAll('/', '\\/')}/`;

const UI_TYPE_ONLY_CORE = 'src/ui imports from src/core only with `import type` (ADR-022).';
const UI_FORBIDDEN = [{ regex: into('cli|daemon'), message: 'src/ui must not import from src/cli or src/daemon.' }];
const CHANGE_SCREEN_FORBIDDEN = [
  ...UI_FORBIDDEN,
  {
    regex: into('(?:ui/)?data'),
    message: 'src/ui/screens/change must not import src/ui/data: it renders from a Report alone (ADR-002, ADR-022).',
  },
];
const DAEMON_FORBIDDEN = [{ regex: into('cli|ui'), message: 'src/daemon must not import from src/cli or src/ui.' }];

// Value imports from src/core in src/ui: an `import` or re-export that is not
// `import type` / `export type` (an inline `import { type X }` still keeps the
// module as a side-effect import), and any dynamic import().
const UI_CORE_VALUE_IMPORTS = [
  `ImportDeclaration[importKind!="type"][source.value=${inSelector(into('core'))}]`,
  `ExportNamedDeclaration[exportKind!="type"][source.value=${inSelector(into('core'))}]`,
  `ExportAllDeclaration[exportKind!="type"][source.value=${inSelector(into('core'))}]`,
  `ImportExpression[source.value=${inSelector(into('core'))}]`,
].map((selector) => ({ selector, message: UI_TYPE_ONLY_CORE }));

/**
 * Rules that forbid every import (types included) matching `patterns`, static or
 * dynamic: no-restricted-imports does not see import(), so a selector covers it.
 * `extraSyntax` adds no-restricted-syntax entries, since a later config object
 * replaces the rule options of an earlier one instead of merging them.
 */
const boundary = (patterns, extraSyntax = []) => ({
  'no-restricted-imports': ['error', { patterns }],
  'no-restricted-syntax': [
    'error',
    ...extraSyntax,
    ...patterns.map(({ regex, message }) => ({ selector: `ImportExpression[source.value=${inSelector(regex)}]`, message })),
  ],
});

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'test-results/', '.worktrees/', '.tmp/', 'design/', 'test/fixtures/'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // All computation lives in src/core; it never depends on the layers that call it.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // A relative import that walks into a cli/, daemon/ or ui/ directory,
              // or any specifier that goes through src/cli, src/daemon or src/ui.
              regex: '^(?:\\.{1,2}/(?:.*/)?|(?:.*/)?src/)(?:cli|daemon|ui)(?:/|$)',
              message: 'src/core must not import from src/cli, src/daemon or src/ui.',
            },
          ],
        },
      ],
    },
  },
  {
    // The UI only renders a Report and the DTOs; it never runs core code (ADR-022).
    files: ['src/ui/**'],
    rules: boundary(UI_FORBIDDEN, UI_CORE_VALUE_IMPORTS),
  },
  {
    // The change screen doubles as the HTML export, so it cannot depend on the daemon client.
    files: ['src/ui/screens/change/**'],
    rules: boundary(CHANGE_SCREEN_FORBIDDEN, UI_CORE_VALUE_IMPORTS),
  },
  {
    // The daemon orchestrates src/core; the CLI and the UI are its clients.
    files: ['src/daemon/**'],
    rules: boundary(DAEMON_FORBIDDEN),
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
