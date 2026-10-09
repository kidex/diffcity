// An in-process daemon with only the database and the agent plugin, for the
// "send review to the agent" tests (ADR-029): a temporary DIFFCITY_HOME, a
// temporary Claude Code config directory, a stub claude on a temporary PATH
// (never a real one), and a seeded invented change with a "Needs rewrite" mark.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Db } from '../../../src/core/db/index.js';
import type { ChangeRecord } from '../../../src/core/model/types.js';
import { emptySettings, writeSettings } from '../../../src/core/settings/index.js';
import { createAgent, type AgentPlugin, type AgentPluginOptions } from '../../../src/daemon/agent/plugin.js';
import { dbPlugin, getDb } from '../../../src/daemon/db.js';
import { startDaemon, type RunningDaemon } from '../../../src/daemon/daemon.js';
import { createStreamLogger } from '../../../src/daemon/log.js';
import { tempHome, type TempHome } from '../../helpers/config.js';
import { call, type Answer } from '../../helpers/review-api.js';
import type { ToolStubs } from '../../helpers/tool-stub.js';
import { branchFields, snapshotInput, T0 } from '../../unit/db/db-helpers.js';
import { sampleFingerprints, sampleReport } from '../../unit/review/review-helpers.js';
import { recordSse, type SseRecord } from '../collect/collect-helpers.js';

export const SYSTEM_PATH = '/usr/bin:/bin';
export const SESSION = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
export const RESULT_SESSION = '11111111-2222-4333-8444-555555555555';
export const REWRITE_NOTE = 'Round the total once, at the end.';
/** A variable only the daemon has: no agent may see it. */
export const DAEMON_ONLY = 'SAMPLE_DAEMON_ONLY_VALUE';
/** An obviously fake API key value, for the allow-list. */
export const FAKE_KEY = 'fake';

export interface AgentDaemon {
  daemon: RunningDaemon;
  agent: AgentPlugin;
  db: Db;
  port: number;
  home: TempHome;
  /** realpath of a scratch directory holding the repo, the worktrees and the Claude config dir. */
  scratch: string;
  /** The repo (realpath), registered; the change is checked out here unless asked otherwise. */
  repoDir: string;
  /** `<scratch>/claude`: the Claude Code configuration directory. */
  claudeDir: string;
  events(): SseRecord[];
  /** Writes `<home>/settings.json` with this `agentLaunch`. */
  settings(agentLaunch: unknown): Promise<void>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer>;
  close(): Promise<void>;
}

export interface StartOptions {
  stubs: ToolStubs;
  plugin?: AgentPluginOptions;
  /** Added to (or overriding) the daemon's environment. */
  env?: Record<string, string>;
}

export async function startAgentDaemon(options: StartOptions): Promise<AgentDaemon> {
  const home = await tempHome();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dc-agent-')));
  const repoDir = join(scratch, 'sample-shop');
  const claudeDir = join(scratch, 'claude');
  await mkdir(repoDir);
  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  const agent = createAgent({ claudeConfigDir: claudeDir, killGraceMs: 300, ...options.plugin });
  const env = { ...home.env, PATH: `${options.stubs.bin}:${SYSTEM_PATH}`, [DAEMON_ONLY]: 'not-for-agents', ANTHROPIC_API_KEY: FAKE_KEY, ...options.env };
  const result = await startDaemon({ env, port: 0, plugins: [dbPlugin, agent.plugin], log: createStreamLogger(new PassThrough()) });
  if (result.status !== 'started') throw new Error(`daemon did not start: ${result.status}`);
  const { daemon } = result;
  const db = await getDb(daemon.context);
  const port = daemon.info.port;
  const sse = await recordSse(port);
  return {
    daemon,
    agent,
    db,
    port,
    home,
    scratch,
    repoDir,
    claudeDir,
    events: () => [...sse.events],
    settings: (agentLaunch) => writeSettings(daemon.context.paths.settings, { ...emptySettings(), agentLaunch }),
    post: (path, body, headers) => call(port, 'POST', path, { ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) }),
    close: async () => {
      sse.close();
      await daemon.shutdown('test cleanup');
      await home.cleanup();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}

export interface SeedOptions {
  /** Where the change is checked out; the repo by default, null for nowhere. */
  worktreePath?: string | null;
  name?: string;
  rewrite?: boolean;
  note?: string;
  archived?: boolean;
}

/** A registered repo at `repoDir` (once) and a branch change with a snapshot and, by default, one "Needs rewrite" mark. */
export function seedChange(test: AgentDaemon, options: SeedOptions = {}): ChangeRecord {
  const { db } = test;
  const repo = db.repos.upsert({ path: test.repoDir, gitCommonDir: join(test.repoDir, '.git'), name: 'sample-shop', active: true, seenAt: T0 }).repo;
  const worktreePath = options.worktreePath === undefined ? test.repoDir : options.worktreePath;
  const change = db.changes.applyPlan(repo.id, { create: [branchFields(options.name ?? 'totals', { worktreePath })], update: [], archive: [] }, T0).created[0];
  if (change === undefined) throw new Error('no change');
  const report = { ...sampleReport(), meta: { ...sampleReport().meta, head: change.head } };
  db.snapshots.put(snapshotInput(change.id, change.head, { report: JSON.stringify(report), fingerprints: JSON.stringify(sampleFingerprints()), contentHash: 'h1' }));
  const snapshot = db.snapshots.latest(change.id);
  if (options.rewrite !== false) {
    db.review.upsert({
      changeId: change.id,
      target: { kind: 'symbol', id: 's-total' },
      filePath: 'src/cart/total.ts',
      mark: 'rewrite',
      note: REWRITE_NOTE,
      lines: null,
      fingerprint: 'sym-total',
      snapshotId: snapshot?.id ?? null,
      at: T0,
    });
  }
  if (options.note !== undefined) db.review.setNote(change.id, options.note, T0);
  if (options.archived === true) db.changes.applyPlan(repo.id, { create: [], update: [], archive: [{ id: change.id, reason: 'merged' }] }, '2026-09-02T00:00:00.000Z');
  return db.changes.get(change.id) ?? change;
}

/** A session linked to the change, run in `cwd`, with its transcript under the Claude config dir unless `transcript` is false. */
export async function linkSession(test: AgentDaemon, change: ChangeRecord, options: { sessionId?: string; cwd?: string; at?: string; transcript?: boolean } = {}): Promise<void> {
  const sessionId = options.sessionId ?? SESSION;
  const dir = join(test.claudeDir, 'projects', 'sample-shop');
  await mkdir(dir, { recursive: true });
  const transcriptPath = join(dir, `${sessionId}.jsonl`);
  if (options.transcript !== false) await writeFile(transcriptPath, '{"type":"user"}\n');
  const row = test.db.sessions.see({ repoId: change.repoId, sessionId, transcriptPath, cwd: options.cwd ?? test.repoDir, at: options.at ?? T0 });
  test.db.sessions.link(change.id, row.id, change.head, options.at ?? T0);
}

/** The settings that allow a launch in the test repo with the stub claude. */
export function enabled(test: AgentDaemon, stubs: ToolStubs, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, repos: [test.repoDir], claudePath: stubs.path('claude'), ...extra };
}

export interface Preview {
  mode: 'resume' | 'new' | null;
  argv: string[] | null;
  cwd: string | null;
  sessionId: string | null;
  newSessionReason: string | null;
  summary: string;
  summaryHash: string;
  refusals: { code: string; message: string }[];
  token: string | null;
}

export async function preview(test: AgentDaemon, changeId: number): Promise<Preview> {
  const answer = await test.post(`/api/changes/${String(changeId)}/agent/preview`);
  if (answer.status !== 200) throw new Error(`preview answered ${String(answer.status)}: ${answer.text}`);
  return answer.json() as Preview;
}

export function run(test: AgentDaemon, changeId: number, body: unknown): Promise<Answer> {
  return test.post(`/api/changes/${String(changeId)}/agent/run`, body);
}

/** The result line the stub claude prints. */
export function claudeResult(sessionId: string = RESULT_SESSION, isError = false): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: 'Rewrote total.', session_id: sessionId });
}

/** The `agent-run` events of the change. */
export function agentRunEvents(test: AgentDaemon): { changeId: number | null; payload: Record<string, unknown> }[] {
  const repo = test.db.repos.list()[0];
  if (repo === undefined) return [];
  return test.db.events
    .listForRepo(repo.id)
    .filter((event) => event.type === 'agent-run')
    .map((event) => ({ changeId: event.changeId, payload: event.payload as Record<string, unknown> }));
}
