// Types of scripts/ci-scope.mjs, for its unit test.

export type Scope = 'none' | 'core' | 'full';

export interface Plan {
  scope: Scope;
  reason: string;
  check: boolean;
  node: number[];
  acceptance: boolean;
  screens: boolean;
  visual: boolean;
}

export const ORDER: Scope[];
export function classifyPath(path: string): Scope;
export function classify(paths: readonly string[]): Scope;
export function plan(input: { event: string; ref?: string; full?: boolean; paths: readonly string[] | null }): Plan;
export function format(p: Plan): string;
