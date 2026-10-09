// "Send review to the agent" as a daemon plugin (ADR-029): the preview, run
// and summary-queue routes, the agent runs, and their end. Listed after the
// API in src/daemon/plugins.ts, so it stops first on shutdown (`diffcity stop`
// included): every running agent gets SIGTERM, then SIGKILL after 10 s, to its
// whole process group, and its run is recorded before the database closes. A
// process exit that comes sooner (a forced shutdown) still SIGKILLs the groups.

import { claudeConfigDir } from '../../core/claude/config-dir.js';
import { claudeProjectsDir } from '../../core/session/validate.js';
import { getDb } from '../db.js';
import type { DaemonPlugin } from '../plugin.js';
import type { ConfirmOptions } from '../actions/confirm.js';
import { registerAgentRoutes } from './routes.js';
import { createAgentRuns, type AgentRuns } from './runs.js';

export interface AgentPluginOptions {
  /** The Claude Code configuration directory; from the daemon's environment when absent. */
  claudeConfigDir?: string;
  /** Between SIGTERM and SIGKILL; 10 s (the claude profile's) when absent. */
  killGraceMs?: number;
  /** Milliseconds per minute of `timeoutMinutes`; tests shorten it. */
  minuteMs?: number;
  now?: () => Date;
  tokens?: ConfirmOptions;
}

export interface AgentPlugin {
  readonly plugin: DaemonPlugin;
  /** The runs, once set up. */
  runs(): AgentRuns;
}

export function createAgent(options: AgentPluginOptions = {}): AgentPlugin {
  let runs: AgentRuns | null = null;
  const onExit = (): void => {
    runs?.killAllNow();
  };
  const now = options.now ?? (() => new Date());
  const plugin: DaemonPlugin = {
    name: 'agent',
    async setup(context, http) {
      const db = await getDb(context);
      let projectsDir: string | null;
      try {
        projectsDir = claudeProjectsDir(options.claudeConfigDir ?? claudeConfigDir(context.env));
      } catch (error) {
        // A relative CLAUDE_CONFIG_DIR: no transcript can be validated, so no session is resumed.
        context.log.warn(`agent launch: ${error instanceof Error ? error.message : String(error)}; sessions will not be resumed`);
        projectsDir = null;
      }
      const created = createAgentRuns({
        db,
        runsDir: context.paths.runs,
        broadcast: (event) => {
          context.broadcast(event);
        },
        log: context.log,
        now,
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
        ...(options.minuteMs === undefined ? {} : { minuteMs: options.minuteMs }),
      });
      runs = created;
      process.on('exit', onExit);
      registerAgentRoutes(http, {
        db,
        settingsPath: context.paths.settings,
        env: context.env,
        projectsDir,
        runs: created,
        port: () => context.port(),
        now,
        ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      });
    },
    async start() {
      await runs?.purge();
    },
    async stop() {
      try {
        await runs?.stopAll();
      } finally {
        process.off('exit', onExit);
      }
    },
  };
  return {
    plugin,
    runs: () => {
      if (runs === null) throw new Error('the agent plugin is not set up');
      return runs;
    },
  };
}

export const agentPlugin: DaemonPlugin = createAgent().plugin;
