import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
