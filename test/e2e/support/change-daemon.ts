// Shared pieces of the phase 3 acceptance specs and the DC-92 proof: one of the
// golden scenarios (test/fixtures/scenarios) tracked by a real daemon, and the
// change the daemon collected for it, found through the API.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeSummary, RepoDetail, RepoSummary } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';
import { CLI_DIST, waitFor } from '../../helpers/daemon.js';
import type { TempRepo } from '../../helpers/repo.js';
import { buildScenario, listScenarios, type Scenario } from '../../helpers/scenario.js';
import { ghStubEnv } from './acceptance.js';
import type { ProofWorld } from './proof.js';

export const GOLDEN = ['order-discounts', 'session-refresh', 'report-cli-command'] as const;
export type GoldenName = (typeof GOLDEN)[number];

export interface TrackedChange {
  scenario: Scenario;
  repo: TempRepo;
  env: NodeJS.ProcessEnv;
  repoId: number;
  change: ChangeSummary;
  /** The report route of this change on the daemon. */
  reportUrl: string;
  /** The change screen's address, with the debug hook on. */
  url: string;
  report(): Promise<Report>;
}

export const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return (await response.json()) as T;
};

/** Runs the built CLI to completion; rejects on a non-zero exit. */
export function cli(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, ...args], { env, stdio: 'ignore' });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`diffcity ${args.join(' ')} exited with ${String(code)}`));
    });
  });
}

/** `waitFor` that treats a refused connection or an empty answer as not ready yet. */
export const until = <T>(check: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> =>
  waitFor(() => check().catch(() => undefined), timeoutMs, what);

/** The daemon's environment: the gh stub first on PATH, the temporary home. Start the daemon with it once. */
export const stubEnv = (world: ProofWorld): Promise<NodeJS.ProcessEnv> => ghStubEnv(world.root, world.env, []);

/**
 * Builds the golden scenario's repo, tracks it with the daemon `world`
 * started with `env`, and waits until the daemon has the change of the
 * scenario's branch with its first snapshot.
 */
export async function trackScenario(world: ProofWorld, env: NodeJS.ProcessEnv, name: GoldenName): Promise<TrackedChange> {
  const scenario = listScenarios().find((candidate) => candidate.name === name);
  if (scenario === undefined) throw new Error(`scenario ${name} missing`);
  const { repo } = await buildScenario(scenario);
  world.onTeardown(() => repo.cleanup());
  await cli(['track', repo.dir], env);
  const base = world.baseURL;
  const repoId = await until(
    async () => (await getJson<RepoSummary[]>(`${base}/api/repos`)).find((r) => r.name === scenario.steps.repo)?.id,
    60_000,
    `${scenario.steps.repo} in /api/repos`,
  );
  const change = await until(
    async () => (await getJson<RepoDetail>(`${base}/api/repos/${String(repoId)}`)).changes.find((c) => c.ref.endsWith(scenario.steps.branch) && c.stats !== null),
    60_000,
    `the ${name} change with its first snapshot`,
  );
  const reportUrl = `${base}/api/changes/${String(change.id)}/report`;
  return { scenario, repo, env, repoId, change, reportUrl, url: `${base}/?scene-debug#/change/${String(change.id)}`, report: () => getJson<Report>(reportUrl) };
}

export const GUARD = 'src/auth/order.guard.ts';
export const SERVICE = 'src/services/orders/orders.service.ts';
export const CAN_PLACE = `${GUARD}#OrderGuard.canPlace`;

/**
 * An agent's edit in the working tree: appends a new top-level function to
 * `file` (a new floor on its building) and returns the file's new content.
 */
export async function appendFunction(repo: TempRepo, file: string, name: string): Promise<string> {
  const current = await readFile(join(repo.dir, file), 'utf8');
  const next = `${current}\nexport function ${name}(total: number): number {\n  return total * 2;\n}\n`;
  await repo.write({ [file]: next });
  return next;
}
