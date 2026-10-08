// The session digest of ADR-038, built from a main transcript, the meta files
// and the sidechain files of its subagents. The functions mutate the digest
// they are given and return it: a worker loads the stored digest, applies the
// bytes appended since `parsedBytes`, finalizes and stores it again.
//
// Read: the user's prompts, AskUserQuestion calls with their answers, the
// agents that ran (joined on agentId and toolUseId, never on
// run_in_background), tool-call counts and edited files. Never read: the main
// agent's text and thinking, tool outputs, file contents, the prompts given to
// subagents. Every string is redacted, then cut to its limit, before it is kept.

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SESSION_LIMITS, truncateUtf8, type SessionLimits } from './limits.js';
import { arr, decodeRecord, forEachLine, isObject, messageContent, num, str, type RawRecord, type TranscriptChunk } from './parse.js';
import { createRedactor, type Redactor } from './redact.js';
import {
  ACTIVITY_KINDS,
  DIGEST_FORMAT,
  type Activity,
  type ActivityKind,
  type AgentRun,
  type FileCursor,
  type SessionDigest,
  type SessionQuestion,
} from './types.js';

export interface DigestContext {
  /** Absolute path of the repo the session's change belongs to; edited files are listed relative to it. */
  repoRoot: string | null;
  /** The home directory replaced by `~`; os.homedir() when omitted. */
  home?: string | null;
  limits?: SessionLimits;
}

export interface FinalizeOptions {
  /** The session is still running: runs with no outcome yet are `running`, else `unknown`. */
  active: boolean;
  limits?: SessionLimits;
}

interface Ctx {
  redact: Redactor;
  limits: SessionLimits;
  repoRoot: string | null;
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_KIND: Readonly<Record<string, ActivityKind>> = {
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Read: 'read-search',
  Grep: 'read-search',
  Glob: 'read-search',
  LS: 'read-search',
  NotebookRead: 'read-search',
  Bash: 'shell',
  bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  KillBash: 'shell',
  Monitor: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'subagents',
  Task: 'subagents',
};
const RUN_STATUSES = new Set(['completed', 'failed', 'killed']);
const STATUS_RANK: Readonly<Record<NonNullable<AgentRun['statusSource']>, number>> = { handback: 1, 'tool-result': 2, notification: 3 };
const REPORT_RANK:Readonly<Record<NonNullable<AgentRun['reportSource']>, number>> = { sidechain: 1, 'tool-result': 2, handback: 3 };
/** User records that carry command or tool output, never a prompt. */
const OUTPUT_TAG = /^\s*<(?:local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification|system-reminder)>/;
const TITLE_CHARS = 80;

function context(input: DigestContext): Ctx {
  return {
    redact: createRedactor(input.home === undefined ? {} : { home: input.home }),
    limits: input.limits ?? SESSION_LIMITS,
    repoRoot: input.repoRoot,
  };
}

export function emptyActivity(): Activity {
  const counts = Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind, 0])) as Record<ActivityKind, number>;
  return { counts, mcp: {}, files: [], filesDropped: 0, outsideFiles: 0 };
}

export function emptyDigest(): SessionDigest {
  return {
    format: DIGEST_FORMAT,
    sessionId: null,
    version: null,
    title: null,
    firstAt: null,
    lastAt: null,
    branch: null,
    prompts: [],
    promptsDropped: 0,
    questions: [],
    questionsDropped: 0,
    runs: [],
    runsDropped: 0,
    main: emptyActivity(),
    files: [],
    filesDropped: 0,
    outsideFiles: 0,
    truncated: false,
    capped: false,
    badLines: 0,
    skippedLines: 0,
    state: { main: { parsedBytes: 0, truncated: false }, sidechains: {}, outside: {}, customTitle: null, aiTitle: null, firstPrompt: null },
  };
}

/** Redacted, then cut to `maxBytes`. */
function clip(c: Ctx, text: string, maxBytes: number): { text: string; truncated: boolean } {
  return truncateUtf8(c.redact(text), maxBytes);
}

function clipText(c: Ctx, text: string): string {
  return clip(c, text, c.limits.promptBytes).text;
}

function timeOf(at: string | null): number {
  const t = at === null ? Number.NaN : Date.parse(at);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// ---------------------------------------------------------------- chunks

function applyLines(digest: SessionDigest, cursor: FileCursor, chunk: TranscriptChunk, c: Ctx, onRecord: (record: RawRecord) => void): void {
  if (chunk.offset !== cursor.parsedBytes) {
    throw new Error(`transcript chunk starts at ${String(chunk.offset)}, the cursor is at ${String(cursor.parsedBytes)}`);
  }
  const slice = forEachLine(chunk, c.limits, (line) => {
    const record = decodeRecord(line);
    if (record === null) digest.badLines++;
    else onRecord(record);
  });
  digest.skippedLines += slice.skippedLines;
  cursor.parsedBytes = slice.parsedBytes;
  cursor.truncated = slice.truncated;
  if (slice.truncated) digest.truncated = true;
}

/** Applies the main transcript bytes from `chunk.offset`, which must be the main cursor. */
export function applyMainChunk(digest: SessionDigest, chunk: TranscriptChunk, input: DigestContext): SessionDigest {
  const c = context(input);
  applyLines(digest, digest.state.main, chunk, c, (record) => {
    onMainRecord(digest, record, c);
  });
  return digest;
}

/** Applies the bytes of `agent-<agentId>.jsonl` from `chunk.offset`, which must be that file's cursor (0 when new). */
export function applySidechainChunk(digest: SessionDigest, agentId: string, chunk: TranscriptChunk, input: DigestContext): SessionDigest {
  const c = context(input);
  const cursor = (digest.state.sidechains[agentId] ??= { parsedBytes: 0, truncated: false });
  const run = runByAgentId(digest, agentId) ?? addRun(digest, newRun({ agentId }));
  const last: { text: string | null } = { text: null };
  applyLines(digest, cursor, chunk, c, (record) => {
    const at = str(record.timestamp);
    if (at !== null) {
      run.sidechainFirstAt ??= at;
      run.sidechainLastAt = at;
    }
    const type = str(record.type);
    if (type === 'assistant') {
      onAssistant(digest, record, c, run);
      const text = assistantText(record);
      if (text !== null) last.text = text;
    } else if (type === 'user') {
      onUser(digest, record, c, run);
    }
  });
  if (last.text !== null) setReport(run, last.text, 'sidechain', c);
  return digest;
}

/** Applies `agent-<agentId>.meta.json`: the run's type, description, spawn depth and parent. */
export function applyAgentMeta(digest: SessionDigest, agentId: string, meta: unknown, input: DigestContext): SessionDigest {
  if (!isObject(meta)) return digest;
  const c = context(input);
  const toolUseId = str(meta.toolUseId);
  let run = runByAgentId(digest, agentId);
  if (run === null && toolUseId !== null) {
    run = runByToolUseId(digest, toolUseId);
    if (run !== null) linkAgentId(digest, run, agentId);
  }
  run ??= addRun(digest, newRun({ agentId, toolUseId }));
  const type = str(meta.agentType);
  if (type !== null) run.type = clipText(c, type);
  const description = str(meta.description);
  if (description !== null) run.description = clipText(c, description);
  const depth = num(meta.spawnDepth);
  if (depth !== null) run.spawnDepth = depth;
  const parent = str(meta.parentAgentId);
  if (parent !== null) run.parentAgentId = parent;
  return digest;
}

// ---------------------------------------------------------------- records

function onMainRecord(digest: SessionDigest, record: RawRecord, c: Ctx): void {
  // Older versions wrote sidechain records into the main file; they belong to no prompt.
  if (record.isSidechain === true) return;
  const type = str(record.type);
  if (type === 'ai-title') {
    const title = str(record.aiTitle);
    if (title !== null && title.trim() !== '') digest.state.aiTitle = clipText(c, title.trim());
    return;
  }
  if (type === 'custom-title') {
    const title = str(record.customTitle);
    if (title !== null && title.trim() !== '') digest.state.customTitle = clipText(c, title.trim());
    return;
  }
  if (type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'attachment') return;
  const version = str(record.version);
  if (version !== null) digest.version = clipText(c, version);
  const sessionId = str(record.sessionId);
  if (sessionId !== null) digest.sessionId ??= clipText(c, sessionId);
  const branch = str(record.gitBranch);
  if (branch !== null && branch !== '') digest.branch = clipText(c, branch);
  const at = str(record.timestamp);
  if (at !== null && Number.isFinite(Date.parse(at))) {
    if (digest.firstAt === null || timeOf(at) < timeOf(digest.firstAt)) digest.firstAt = at;
    if (digest.lastAt === null || timeOf(at) > timeOf(digest.lastAt)) digest.lastAt = at;
  }
  if (type === 'user') onUser(digest, record, c, null);
  else if (type === 'assistant') onAssistant(digest, record, c, null);
}

/** Tool calls of an assistant record, from the main agent (`run` null) or a run's sidechain. */
function onAssistant(digest: SessionDigest, record: RawRecord, c: Ctx, run: AgentRun | null): void {
  const content = messageContent(record);
  if (!Array.isArray(content)) return;
  const at = str(record.timestamp);
  const cwd = str(record.cwd);
  for (const block of content) {
    if (!isObject(block) || block.type !== 'tool_use') continue;
    const name = str(block.name);
    const id = str(block.id);
    const input = isObject(block.input) ? block.input : {};
    if (name === null) continue;
    countTool(run === null ? digest.main : run.activity, name, c);
    if (EDIT_TOOLS.has(name)) {
      const target = str(input.file_path) ?? str(input.notebook_path);
      if (target !== null) recordEdit(digest, run, target, cwd, c);
    }
    if (AGENT_TOOLS.has(name) && id !== null) onAgentCall(digest, id, input, at, run, c);
    if (name === 'AskUserQuestion' && id !== null && run === null) onQuestions(digest, id, input, at, c);
  }
}

function onUser(digest: SessionDigest, record: RawRecord, c: Ctx, run: AgentRun | null): void {
  const content = messageContent(record);
  const origin = isObject(record.origin) ? record.origin : null;
  // Notifications carry `origin.kind: 'task-notification'`; older versions only the leading tag.
  // A prompt that merely mentions the tag is still a prompt.
  if (origin?.kind === 'task-notification' || (typeof content === 'string' && content.trimStart().startsWith('<task-notification>'))) {
    if (typeof content === 'string') onNotification(digest, content);
    return;
  }
  if (origin?.kind === 'peer') {
    if (origin.handback === true) onHandback(digest, origin, c);
    return;
  }
  if (Array.isArray(content) && content.some((block) => isObject(block) && block.type === 'tool_result')) {
    for (const block of content) if (isObject(block) && block.type === 'tool_result') onToolResult(digest, block, record.toolUseResult, c);
    return;
  }
  if (run === null) onPrompt(digest, record, content, origin, c);
}

// ---------------------------------------------------------------- prompts

function onPrompt(
  digest: SessionDigest,
  record: RawRecord,
  content: string | readonly unknown[] | null,
  origin: Readonly<Record<string, unknown>> | null,
  c: Ctx,
): void {
  if (record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return;
  if (origin !== null && (origin.kind === 'producer' || 'producer' in origin)) return;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) if (isObject(block) && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    text = texts.join('\n');
  } else return;
  if (OUTPUT_TAG.test(text)) return;
  let command = false;
  // A slash command expansion starts with its tags; a prompt that mentions them is not one.
  const commandName = /^\s*<command-(?:name|message)>/.test(text) ? /<command-name>([\s\S]*?)<\/command-name>/.exec(text) : null;
  if (commandName !== null) {
    const name = (commandName[1] ?? '').trim();
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '').trim();
    text = `${name.startsWith('/') ? name : `/${name}`}${args === '' ? '' : ` ${args}`}`;
    command = true;
  }
  text = text.trim();
  if (text === '') return;
  const clipped = clip(c, text, c.limits.promptBytes);
  digest.prompts.push({ at: str(record.timestamp), text: clipped.text, command, truncated: clipped.truncated });
  if (digest.state.firstPrompt === null) digest.state.firstPrompt = titleFrom(clipped.text);
  const over = digest.prompts.length - c.limits.prompts;
  if (over > 0) {
    digest.prompts.splice(0, over);
    digest.promptsDropped += over;
  }
}

function titleFrom(text: string): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, TITLE_CHARS).join('');
}

// ---------------------------------------------------------------- questions

function onQuestions(digest: SessionDigest, toolUseId: string, input: Readonly<Record<string, unknown>>, at: string | null, c: Ctx): void {
  for (const item of arr(input.questions)) {
    if (!isObject(item)) continue;
    const question = clip(c, str(item.question) ?? '', c.limits.promptBytes);
    const header = clip(c, str(item.header) ?? '', c.limits.promptBytes);
    const options = arr(item.options)
      .map((option) => (isObject(option) ? str(option.label) : null))
      .filter((label): label is string => label !== null)
      .map((label) => clipText(c, label));
    digest.questions.push({
      toolUseId,
      at,
      header: header.text,
      question: question.text,
      options,
      multiSelect: item.multiSelect === true,
      answer: null,
      truncated: question.truncated || header.truncated,
    });
  }
  // The latest questions are kept, like prompts and runs.
  const over = digest.questions.length - c.limits.questions;
  if (over > 0) {
    digest.questions.splice(0, over);
    digest.questionsDropped += over;
  }
}

function onAnswers(questions: SessionQuestion[], toolUseResult: unknown, c: Ctx): void {
  if (!isObject(toolUseResult) || !isObject(toolUseResult.answers)) return;
  // Answers are keyed by the question text; the stored question is redacted and cut the same way.
  const answers = new Map<string, unknown>();
  for (const [question, answer] of Object.entries(toolUseResult.answers)) answers.set(clipText(c, question), answer);
  for (const question of questions) {
    const answer = answers.get(question.question);
    const text = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.filter((a) => typeof a === 'string').join(', ') : null;
    if (text === null) continue;
    const clipped = clip(c, text, c.limits.promptBytes);
    question.answer = clipped.text;
    if (clipped.truncated) question.truncated = true;
  }
}

// ---------------------------------------------------------------- agents

function newRun(init: { toolUseId?: string | null; agentId?: string | null; parentAgentId?: string | null; startedAt?: string | null }): AgentRun {
  return {
    toolUseId: init.toolUseId ?? null,
    agentId: init.agentId ?? null,
    parentAgentId: init.parentAgentId ?? null,
    order: 0,
    type: null,
    description: null,
    spawnDepth: null,
    foreground: false,
    startedAt: init.startedAt ?? null,
    status: 'running',
    statusSource: null,
    durationMs: null,
    durationApproximate: false,
    toolUses: null,
    report: null,
    reportSource: null,
    reportTruncated: false,
    sidechainFirstAt: null,
    sidechainLastAt: null,
    activity: emptyActivity(),
  };
}

function addRun(digest: SessionDigest, run: AgentRun): AgentRun {
  digest.runs.push(run);
  return run;
}

function runByAgentId(digest: SessionDigest, agentId: string): AgentRun | null {
  return digest.runs.find((run) => run.agentId === agentId) ?? null;
}

function runByToolUseId(digest: SessionDigest, toolUseId: string): AgentRun | null {
  return digest.runs.find((run) => run.toolUseId === toolUseId) ?? null;
}

function mergeActivity(into: Activity, from: Activity, limit: number): void {
  for (const kind of ACTIVITY_KINDS) into.counts[kind] += from.counts[kind];
  for (const [server, count] of Object.entries(from.mcp)) into.mcp[server] = (into.mcp[server] ?? 0) + count;
  for (const file of from.files) {
    if (into.files.includes(file)) continue;
    if (into.files.length < limit) into.files.push(file);
    else into.filesDropped++;
  }
  into.filesDropped += from.filesDropped;
  into.outsideFiles += from.outsideFiles;
}

/**
 * Gives `run` its agentId. A run already known by that agentId (from its meta
 * or sidechain file, read before the tool result) is folded into `run`.
 */
function linkAgentId(digest: SessionDigest, run: AgentRun, agentId: string): void {
  if (run.agentId === agentId) return;
  const other = runByAgentId(digest, agentId);
  run.agentId = agentId;
  if (other === null || other === run) return;
  run.parentAgentId ??= other.parentAgentId;
  // A spawn depth means the meta file was read: its type and description win over the call's.
  const fromMeta = other.spawnDepth !== null;
  run.type = fromMeta ? (other.type ?? run.type) : (run.type ?? other.type);
  run.description = fromMeta ? (other.description ?? run.description) : (run.description ?? other.description);
  run.spawnDepth ??= other.spawnDepth;
  run.startedAt ??= other.startedAt;
  run.sidechainFirstAt ??= other.sidechainFirstAt;
  run.sidechainLastAt = other.sidechainLastAt ?? run.sidechainLastAt;
  if (statusRank(other.statusSource) > statusRank(run.statusSource)) {
    run.status = other.status;
    run.statusSource = other.statusSource;
    run.durationMs = other.durationMs;
    run.toolUses = other.toolUses;
  }
  if (reportRank(other.reportSource) > reportRank(run.reportSource)) {
    run.report = other.report;
    run.reportSource = other.reportSource;
    run.reportTruncated = other.reportTruncated;
  }
  mergeActivity(run.activity, other.activity, Number.POSITIVE_INFINITY);
  digest.runs.splice(digest.runs.indexOf(other), 1);
}

function onAgentCall(digest: SessionDigest, toolUseId: string, input: Readonly<Record<string, unknown>>, at: string | null, parent: AgentRun | null, c: Ctx): void {
  const run = runByToolUseId(digest, toolUseId) ?? addRun(digest, newRun({ toolUseId }));
  run.startedAt ??= at;
  if (parent !== null && parent.agentId !== null) run.parentAgentId ??= parent.agentId;
  const type = str(input.subagent_type);
  if (type !== null) run.type ??= clipText(c, type);
  const description = str(input.description);
  if (description !== null) run.description ??= clipText(c, description);
  // input.prompt is the prompt given to the subagent: never read.
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  const texts = arr(content)
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text);
  return texts.length === 0 ? null : texts.join('\n');
}

function onToolResult(digest: SessionDigest, block: Readonly<Record<string, unknown>>, toolUseResult: unknown, c: Ctx): void {
  const toolUseId = str(block.tool_use_id);
  if (toolUseId === null) return;
  const questions = digest.questions.filter((question) => question.toolUseId === toolUseId);
  if (questions.length > 0) {
    onAnswers(questions, toolUseResult, c);
    return;
  }
  const run = runByToolUseId(digest, toolUseId);
  if (run === null) return;
  // Every other tool result is a tool output: never read.
  if (!isObject(toolUseResult)) {
    if (block.is_error === true && run.agentId === null && run.statusSource === null) {
      run.status = 'failed';
      run.statusSource = 'tool-result';
    }
    return;
  }
  const agentId = str(toolUseResult.agentId);
  if (agentId !== null) linkAgentId(digest, run, agentId);
  const agentType = str(toolUseResult.agentType);
  if (agentType !== null) run.type ??= clipText(c, agentType);
  if (toolUseResult.status === 'completed') {
    // A foreground run: the report is in the tool result.
    run.foreground = true;
    if (run.statusSource !== 'notification') {
      run.status = 'completed';
      run.statusSource = 'tool-result';
      run.durationMs = num(toolUseResult.totalDurationMs);
      run.toolUses = num(toolUseResult.totalToolUseCount);
    }
    const report = textOf(toolUseResult.content) ?? textOf(block.content);
    if (report !== null) setReport(run, report, 'tool-result', c);
  }
}

function tag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
  return match === null ? null : (match[1] ?? '').trim();
}

function onNotification(digest: SessionDigest, text: string): void {
  const taskId = tag(text, 'task-id');
  const toolUseId = tag(text, 'tool-use-id');
  const run = (taskId !== null ? runByAgentId(digest, taskId) : null) ?? (toolUseId !== null ? runByToolUseId(digest, toolUseId) : null);
  if (run === null) return;
  const status = tag(text, 'status');
  if (status === null || !RUN_STATUSES.has(status)) return;
  run.status = status as AgentRun['status'];
  run.statusSource = 'notification';
  const duration = Number(tag(text, 'duration_ms') ?? Number.NaN);
  if (Number.isFinite(duration)) {
    run.durationMs = duration;
    run.durationApproximate = false;
  }
  const toolUses = Number(tag(text, 'tool_uses') ?? Number.NaN);
  if (Number.isFinite(toolUses)) run.toolUses = toolUses;
  // <result> is the run's output: the report comes from the handback.
}

function onHandback(digest: SessionDigest, origin: Readonly<Record<string, unknown>>, c: Ctx): void {
  const sender = str(origin.senderTaskId);
  const body = str(origin.body);
  if (sender === null || body === null) return;
  const run = runByAgentId(digest, sender);
  if (run === null) return;
  setReport(run, body, 'handback', c);
  // A handback ends the run; a notification, earlier or later, still wins.
  if (run.statusSource === null) {
    run.status = 'completed';
    run.statusSource = 'handback';
  }
}

function statusRank(source: AgentRun['statusSource']): number {
  return source === null ? 0 : STATUS_RANK[source];
}

function reportRank(source: AgentRun['reportSource']): number {
  return source === null ? 0 : REPORT_RANK[source];
}

function setReport(run: AgentRun, text: string, source: NonNullable<AgentRun['reportSource']>, c: Ctx): void {
  if (reportRank(run.reportSource) > reportRank(source)) return;
  const clipped = clip(c, text.trim(), c.limits.reportBytes);
  run.report = clipped.text;
  run.reportSource = source;
  run.reportTruncated = clipped.truncated;
}

function assistantText(record: RawRecord): string | null {
  const content = messageContent(record);
  if (!Array.isArray(content)) return null;
  const text = textOf(content);
  return text === null || text.trim() === '' ? null : text;
}

// ---------------------------------------------------------------- activity

function countTool(activity: Activity, name: string, c: Ctx): void {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const end = rest.indexOf('__');
    const server = clipText(c, end === -1 ? rest : rest.slice(0, end));
    activity.counts.mcp++;
    activity.mcp[server] = (activity.mcp[server] ?? 0) + 1;
    return;
  }
  activity.counts[TOOL_KIND[name] ?? 'other']++;
}

interface FileTally {
  files: string[];
  filesDropped: number;
  outsideFiles: number;
}

function listFile(tally: FileTally, file: string, limit: number): void {
  if (tally.files.includes(file)) return;
  if (tally.files.length < limit) tally.files.push(file);
  else tally.filesDropped++;
}

function countOutside(digest: SessionDigest, scope: string, tally: FileTally, key: string, limit: number): void {
  const keys = (digest.state.outside[scope] ??= []);
  if (keys.includes(key)) return;
  if (keys.length < limit) keys.push(key);
  tally.outsideFiles++;
}

function recordEdit(digest: SessionDigest, run: AgentRun | null, target: string, cwd: string | null, c: Ctx): void {
  const absolute = isAbsolute(target) ? resolve(target) : cwd !== null ? resolve(cwd, target) : null;
  const rel = absolute !== null && c.repoRoot !== null ? relative(c.repoRoot, absolute) : null;
  const scope = run === null ? 'main' : (run.agentId ?? run.toolUseId ?? 'run');
  const tally = run === null ? digest.main : run.activity;
  if (rel !== null && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    const file = c.redact(rel.split(sep).join('/'));
    listFile(tally, file, c.limits.files);
    listFile(digest, file, c.limits.files);
    return;
  }
  // Outside the repo: counted, never listed; only a hash of the path is kept to count it once.
  const key = createHash('sha256')
    .update(absolute ?? target)
    .digest('hex')
    .slice(0, 16);
  countOutside(digest, scope, tally, key, c.limits.files);
  countOutside(digest, 'session', digest, key, c.limits.files);
}

// ---------------------------------------------------------------- finalize

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Settles what depends on the whole session: run order and the latest
 * `limits.runs` runs, the running/unknown fallback, approximate durations,
 * the title, and the digest size limit. Idempotent: a finalized digest can
 * take more chunks and be finalized again.
 */
export function finalizeDigest(digest: SessionDigest, options: FinalizeOptions): SessionDigest {
  const limits = options.limits ?? SESSION_LIMITS;
  const indexed = digest.runs.map((run, index) => ({ run, index }));
  indexed.sort((a, b) => timeOf(a.run.startedAt ?? a.run.sidechainFirstAt) - timeOf(b.run.startedAt ?? b.run.sidechainFirstAt) || a.index - b.index);
  digest.runs = indexed.map(({ run }) => run);
  const over = digest.runs.length - limits.runs;
  if (over > 0) dropRuns(digest, over);

  digest.runs.forEach((run, index) => {
    run.order = index + 1;
    if (run.statusSource === null) run.status = options.active ? 'running' : 'unknown';
    if (run.durationMs === null || run.durationApproximate) {
      const first = timeOf(run.sidechainFirstAt);
      const last = timeOf(run.sidechainLastAt);
      if (Number.isFinite(first) && Number.isFinite(last)) {
        run.durationMs = Math.max(0, last - first);
        run.durationApproximate = true;
      }
    }
  });
  // Stored digests from before custom titles have no customTitle field.
  digest.title = digest.state.customTitle ?? digest.state.aiTitle ?? digest.state.firstPrompt;
  capDigest(digest, limits.digestBytes);
  return digest;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function dropRuns(digest: SessionDigest, count: number): void {
  for (const run of digest.runs.splice(0, count)) {
    if (run.agentId !== null) {
      // Its sidechain is no longer followed.
      digest.state.sidechains = without(digest.state.sidechains, run.agentId);
      digest.state.outside = without(digest.state.outside, run.agentId);
    }
  }
  digest.runsDropped += count;
}

/** Drops content, least useful first, until the serialized digest fits `maxBytes`. */
function capDigest(digest: SessionDigest, maxBytes: number): void {
  let size = bytesOf(digest);
  if (size <= maxBytes) return;
  digest.capped = true;
  // 1. Reports of the oldest runs.
  for (const run of digest.runs) {
    if (size <= maxBytes) break;
    if (run.report === null) continue;
    size -= bytesOf(run.report) - bytesOf(null);
    run.report = null;
    run.reportTruncated = true;
  }
  // 2. The oldest prompts.
  while (size > maxBytes && digest.prompts.length > 0) {
    size -= bytesOf(digest.prompts.shift()) + 1;
    digest.promptsDropped++;
  }
  // 3. The oldest questions.
  while (size > maxBytes && digest.questions.length > 0) {
    size -= bytesOf(digest.questions.shift()) + 1;
    digest.questionsDropped++;
  }
  // 4. The estimates above ignore counters that grew a digit: check the real size, dropping the oldest runs, then file lists.
  while (bytesOf(digest) > maxBytes) {
    if (digest.runs.length > 0) {
      dropRuns(digest, 1);
      continue;
    }
    const lists: FileTally[] = [digest, digest.main];
    const tally = lists.find((list) => list.files.length > 0);
    if (tally === undefined) break;
    tally.filesDropped += tally.files.length;
    tally.files = [];
  }
}
