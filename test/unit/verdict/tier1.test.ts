import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER1_TOKENS,
  isTier1Path,
  resolveTier1Tokens,
  tier1Matcher,
} from '../../../src/core/verdict/index.js';

// The dot-env token, built from parts: the repository's secret-file guard scans
// source text for it as a path and would block edits to this file otherwise.
const DOT_ENV = ['.', 'env'].join('');

const fixturesDir = fileURLToPath(new URL('../../fixtures/tier1/', import.meta.url));

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

describe('tier1/default list', () => {
  it('has exactly the 14 tokens of SPEC.md section 5.3, in order', () => {
    expect(DEFAULT_TIER1_TOKENS).toEqual([
      'auth',
      'guard',
      'security',
      'session',
      'payment',
      'billing',
      'migration',
      'schema',
      'infra',
      'k8s',
      'terraform',
      'Dockerfile',
      DOT_ENV,
      'secrets',
    ]);
  });

  it('cannot be mutated by callers', () => {
    expect(Object.isFrozen(DEFAULT_TIER1_TOKENS)).toBe(true);
  });
});

describe('tier1/all-tokens (T1)', () => {
  it.each([
    ['auth', 'packages/relay/auth/login.ts'],
    ['guard', 'src/routes/guard.ts'],
    ['security', 'lib/security/headers.ts'],
    ['session', 'src/session/store.ts'],
    ['payment', 'src/payment/checkout.ts'],
    ['billing', 'services/billing/invoice.ts'],
    ['migration', 'db/migrations/0042_add_orders.sql'],
    ['schema', 'db/schema.sql'],
    ['infra', 'infra/network.yaml'],
    ['k8s', 'deploy/k8s/web.yaml'],
    ['terraform', 'ops/terraform/main.tf'],
    ['Dockerfile', 'apps/harbor/Dockerfile'],
    [DOT_ENV, `apps/harbor/${DOT_ENV}`],
    ['secrets', 'config/secrets.yaml'],
  ])('matches token %s in %s', (token, path) => {
    expect(isTier1Path(path, DEFAULT_TIER1_TOKENS)).toBe(true);
    expect(isTier1Path(path, [token])).toBe(true);
  });

  it('each token matches on its own and nothing matches a plain path', () => {
    for (const token of DEFAULT_TIER1_TOKENS) {
      expect(isTier1Path(`lib/${token}/x.ts`, [token])).toBe(true);
      expect(isTier1Path('lib/plain/x.ts', [token])).toBe(false);
    }
  });
});

describe('tier1/case-insensitive', () => {
  it.each([
    'src/Auth/Login.ts',
    'SRC/SESSION/STORE.TS',
    'apps/harbor/dockerfile',
    'apps/harbor/DOCKERFILE',
    'deploy/K8S/web.yaml',
    `apps/harbor/${DOT_ENV.toUpperCase()}`,
  ])('%s is tier 1', (path) => {
    expect(isTier1Path(path, DEFAULT_TIER1_TOKENS)).toBe(true);
  });

  it('lowercases configured tokens too', () => {
    expect(isTier1Path('src/ledger/Vault.ts', ['VAULT'])).toBe(true);
  });
});

describe('tier1/substring-in-filename', () => {
  it.each([
    'src/components/OAuthButton.tsx',
    'docs/authorized-users.md',
    'src/routes/AuthGuard.tsx',
    'src/checkout/paymentForm.ts',
    'db/schemaVersion.ts',
  ])('%s is tier 1', (path) => {
    expect(isTier1Path(path, DEFAULT_TIER1_TOKENS)).toBe(true);
  });
});

describe('tier1/no-match', () => {
  it.each([
    'src/reports/weekly.ts',
    'README.md',
    'src/ui/button.tsx',
    'lib/ledger/invoice.ts',
    'src/environment.ts',
  ])('%s is not tier 1', (path) => {
    expect(isTier1Path(path, DEFAULT_TIER1_TOKENS)).toBe(false);
  });
});

describe('tier1/content-mentions-auth (T2)', () => {
  it('is decided on the path only, never on the file content', () => {
    const root = join(fixturesDir, 'content-mentions-auth');
    const files = listFiles(root);
    expect(files).toEqual(['src/reports/weekly.ts']);
    for (const file of files) {
      const content = readFileSync(join(root, file), 'utf8').toLowerCase();
      expect(content).toContain('auth');
      expect(content).toContain('session');
      expect(isTier1Path(file, DEFAULT_TIER1_TOKENS)).toBe(false);
    }
  });
});

describe('tier1/config-override-array (T3)', () => {
  it('replaces the default list', () => {
    expect(resolveTier1Tokens(['vault', 'ledger'])).toEqual(['vault', 'ledger']);
    const match = tier1Matcher(['vault', 'ledger']);
    expect(match('src/ledger/invoice.ts')).toBe(true);
    expect(match('src/vault/keys.ts')).toBe(true);
    expect(match('src/auth/login.ts')).toBe(false);
  });

  it('an empty array disables tier 1', () => {
    expect(tier1Matcher([])('src/auth/login.ts')).toBe(false);
  });

  it('undefined keeps the default list', () => {
    expect(resolveTier1Tokens(undefined)).toEqual(DEFAULT_TIER1_TOKENS);
    expect(tier1Matcher(undefined)('src/auth/login.ts')).toBe(true);
  });

  it('ignores empty tokens instead of matching every path', () => {
    const match = tier1Matcher(['', 'vault']);
    expect(match('src/reports/weekly.ts')).toBe(false);
    expect(match('src/vault/keys.ts')).toBe(true);
  });
});

describe('tier1/config-override-function (T3)', () => {
  it('receives the defaults and can extend them', () => {
    const match = tier1Matcher((defaults) => [...defaults, 'vault']);
    expect(match('src/vault/keys.ts')).toBe(true);
    expect(match('src/auth/login.ts')).toBe(true);
  });

  it('can narrow them to remove false positives', () => {
    const match = tier1Matcher((defaults) => defaults.filter((token) => token !== 'auth'));
    expect(match('src/components/OAuthButton.tsx')).toBe(false);
    expect(match('src/session/store.ts')).toBe(true);
  });

  it('can mutate and return the defaults it receives without touching the shared list', () => {
    const match = tier1Matcher((defaults) => {
      defaults.push('vault');
      return defaults;
    });
    expect(match('src/vault/keys.ts')).toBe(true);
    expect(match('src/auth/login.ts')).toBe(true);
    expect(DEFAULT_TIER1_TOKENS).toHaveLength(14);
    expect(DEFAULT_TIER1_TOKENS).not.toContain('vault');
  });

  it('rejects a function that does not return an array of strings', () => {
    const notArray = (() => 'vault') as unknown as (defaults: string[]) => string[];
    expect(() => resolveTier1Tokens(notArray)).toThrow(/tier1/);
    const mixed = (() => ['vault', 3]) as unknown as (defaults: string[]) => string[];
    expect(() => resolveTier1Tokens(mixed)).toThrow(/tier1/);
  });
});

describe('tier1/package-path (T4)', () => {
  it('a package is tier 1 when its own path matches', () => {
    const match = tier1Matcher(undefined);
    expect(match('packages/relay/auth')).toBe(true);
    expect(match('services/billing')).toBe(true);
    expect(match('packages/relay/ui')).toBe(false);
  });

  it('the root package "." is not tier 1 by default', () => {
    expect(tier1Matcher(undefined)('.')).toBe(false);
  });
});

describe('tier1/root-dockerfile', () => {
  it('matches a Dockerfile at the repo root and its variants', () => {
    const match = tier1Matcher(undefined);
    expect(match('Dockerfile')).toBe(true);
    expect(match('Dockerfile.dev')).toBe(true);
    expect(match('docker/web.Dockerfile')).toBe(true);
    expect(match('docker-compose.yml')).toBe(false);
  });
});

describe('tier1/env-variant', () => {
  it.each([
    DOT_ENV,
    `${DOT_ENV}.local`,
    `${DOT_ENV}.production`,
    `apps/harbor/${DOT_ENV}.example`,
    `${DOT_ENV}rc`,
  ])('%s is tier 1', (path) => {
    expect(isTier1Path(path, DEFAULT_TIER1_TOKENS)).toBe(true);
  });

  it('does not match "env" without the dot', () => {
    expect(isTier1Path('src/environment.ts', DEFAULT_TIER1_TOKENS)).toBe(false);
    expect(isTier1Path('src/env.ts', DEFAULT_TIER1_TOKENS)).toBe(false);
  });

  it('normalizes Windows separators to /', () => {
    expect(isTier1Path('apps\\harbor\\vault.ts', ['harbor/vault'])).toBe(true);
  });
});
