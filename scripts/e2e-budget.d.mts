// Types of scripts/e2e-budget.mjs, for its unit test.

export const LIMITS: { screens: number; acceptance: number };
export function countSpecs(folder: string): number;
export function overBudget(
  counts: { screens: number; acceptance: number },
  limits?: { screens: number; acceptance: number },
): string[];
