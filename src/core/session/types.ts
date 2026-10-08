// The session digest of ADR-038: what diffcity keeps of a Claude Code session.
// Every string in it is redacted and size-capped. It never holds the main
// agent's text or thinking, tool outputs, file contents or the prompts given to
// subagents. It doubles as the resume state: `state` records how far each
// transcript file was parsed, so a later read continues from there.

/** Tool-call kinds of the activity summary. `mcp` is also split by server. */
export type ActivityKind = 'edit' | 'read-search' | 'shell' | 'web' | 'subagents' | 'mcp' | 'other';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['edit', 'read-search', 'shell', 'web', 'subagents', 'mcp', 'other'];

export interface Activity {
  /** Tool calls by kind. */
  counts: Record<ActivityKind, number>;
  /** MCP tool calls by server name. */
  mcp: Record<string, number>;
  /** Repo-relative files edited (Edit, Write, MultiEdit, NotebookEdit), first edit first, at most `limits.files`. */
  files: string[];
  /** Edits of files left out of `files` once it was full. */
  filesDropped: number;
  /** Distinct files edited outside the repo: counted, never listed. */
  outsideFiles: number;
}

export interface SessionPrompt {
  /** ISO timestamp of the record, null when it had none. */
  at: string | null;
  text: string;
  /** A slash command, kept as its command line only. */
  command: boolean;
  truncated: boolean;
}

export interface SessionQuestion {
  toolUseId: string;
  at: string | null;
  header: string;
  question: string;
  /** Option labels, in order. */
  options: string[];
  multiSelect: boolean;
  /** The user's answer; null while unanswered or when the call got none. */
  answer: string | null;
  truncated: boolean;
}

/**
 * `running` and `unknown` are not evidence: a run with no notification and no
 * foreground result is `running` while the session is active, `unknown` after.
 */
export type RunStatus = 'running' | 'completed' | 'failed' | 'killed' | 'unknown';

export interface AgentRun {
  /** The `Agent` (or `Task`) tool call; null for a run known only from its meta file. */
  toolUseId: string | null;
  /** From the tool result or the meta file; null until one of them is read. */
  agentId: string | null;
  /** The run that launched this one; null for runs of the main agent. */
  parentAgentId: string | null;
  /** 1-based position by start time across the session. */
  order: number;
  /** The subagent type: the meta file's `agentType`, else the call's `subagent_type`. */
  type: string | null;
  description: string | null;
  spawnDepth: number | null;
  /** The run returned its report in the tool result (not launched in the background). */
  foreground: boolean;
  startedAt: string | null;
  status: RunStatus;
  /** Where `status` came from; null when it is the running/unknown fallback. */
  statusSource: 'notification' | 'tool-result' | 'handback' | null;
  durationMs: number | null;
  /** The duration is the span of the sidechain's timestamps, not a measured one. */
  durationApproximate: boolean;
  toolUses: number | null;
  report: string | null;
  reportSource: 'handback' | 'tool-result' | 'sidechain' | null;
  reportTruncated: boolean;
  /** First and last timestamps of the sidechain file. */
  sidechainFirstAt: string | null;
  sidechainLastAt: string | null;
  activity: Activity;
}

/** How far one transcript file has been parsed. */
export interface FileCursor {
  /** Bytes consumed, always at a line boundary. */
  parsedBytes: number;
  /** The file is larger than the read limit. */
  truncated: boolean;
}

export interface DigestState {
  main: FileCursor;
  /** Sidechain files by agentId. */
  sidechains: Record<string, FileCursor>;
  /** Hashed keys of the outside-repo files counted per scope (`session`, `main`, or an agentId): never the paths. */
  outside: Record<string, string[]>;
  /** The last `custom-title`, set by the user; optional in digests stored before it existed. */
  customTitle?: string | null;
  /** The last `ai-title`. */
  aiTitle: string | null;
  /** The first prompt's first 80 characters. */
  firstPrompt: string | null;
}

export const DIGEST_FORMAT = 1;

export interface SessionDigest {
  format: typeof DIGEST_FORMAT;
  sessionId: string | null;
  /** The last Claude Code `version` seen. */
  version: string | null;
  /** The last `custom-title`, else the last `ai-title`, else the first prompt's first 80 characters. */
  title: string | null;
  firstAt: string | null;
  lastAt: string | null;
  branch: string | null;
  prompts: SessionPrompt[];
  promptsDropped: number;
  questions: SessionQuestion[];
  questionsDropped: number;
  runs: AgentRun[];
  runsDropped: number;
  /** The main agent's activity. */
  main: Activity;
  /** The whole session's edited files: the main agent and every run. */
  files: string[];
  filesDropped: number;
  outsideFiles: number;
  /** A transcript file was larger than the read limit. */
  truncated: boolean;
  /** Content was dropped to keep the digest under its size limit. */
  capped: boolean;
  /** Lines that were not a JSON object. */
  badLines: number;
  /** Lines over the line limit, skipped unread. */
  skippedLines: number;
  state: DigestState;
}
