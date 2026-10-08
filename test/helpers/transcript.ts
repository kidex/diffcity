// Invented Claude Code transcripts for the session digest tests (ADR-038). The
// records follow the shapes checked against Claude Code 2.1.29x: main and
// sidechain records, Agent calls launched in the background or run in the
// foreground, task notifications, handbacks, AskUserQuestion calls and
// `ai-title` records. Nothing here comes from a real transcript.

import {
  applyAgentMeta,
  applyMainChunk,
  applySidechainChunk,
  emptyDigest,
  finalizeDigest,
  type DigestContext,
  type SessionDigest,
} from '../../src/core/session/index.js';

type Rec = Record<string, unknown>;

export interface TranscriptOptions {
  sessionId?: string;
  cwd?: string;
  branch?: string;
  version?: string;
  /** ISO time of the first record; each record is one second later. */
  start?: string;
  /** Builds the sidechain of this agent instead of a main transcript. */
  agentId?: string;
}

export interface AgentOptions {
  type?: string;
  description?: string;
  prompt?: string;
  agentId: string;
  toolUseId?: string;
  /** A foreground run: the report comes back in the tool result. */
  foreground?: { report: string; durationMs: number; toolUses: number };
}

export interface NotificationOptions {
  agentId: string;
  toolUseId?: string;
  status: 'completed' | 'failed' | 'killed';
  durationMs?: number;
  toolUses?: number;
  result?: string;
}

export interface QuestionInput {
  question: string;
  header: string;
  options: string[];
  multiSelect?: boolean;
}

export class TranscriptBuilder {
  readonly records: Rec[] = [];
  private time: number;
  private seq = 0;
  private lastUuid: string | null = null;

  constructor(private readonly options: TranscriptOptions = {}) {
    this.time = Date.parse(options.start ?? '2026-09-01T09:00:00.000Z');
  }

  /** A record with the common fields of the transcript. */
  private base(type: string, extra: Rec): Rec {
    const uuid = `uuid-${String(++this.seq).padStart(4, '0')}`;
    const record: Rec = {
      parentUuid: this.lastUuid,
      isSidechain: this.options.agentId !== undefined,
      userType: 'external',
      cwd: this.options.cwd ?? '/work/shopfront',
      sessionId: this.options.sessionId ?? 'session-0001',
      version: this.options.version ?? '2.1.295',
      gitBranch: this.options.branch ?? 'feature/cart',
      ...(this.options.agentId !== undefined ? { agentId: this.options.agentId } : {}),
      type,
      uuid,
      timestamp: new Date(this.time).toISOString(),
      ...extra,
    };
    this.time += 1000;
    this.lastUuid = uuid;
    this.records.push(record);
    return record;
  }

  /** Moves the clock forward. */
  wait(ms: number): this {
    this.time += ms;
    return this;
  }

  raw(record: Rec): this {
    this.records.push(record);
    return this;
  }

  user(content: unknown, extra: Rec = {}): this {
    this.base('user', { message: { role: 'user', content }, ...extra });
    return this;
  }

  /** A prompt typed by the user (newer versions mark it with `origin.kind: 'human'`). */
  prompt(text: string, extra: Rec = {}): this {
    return this.user(text, extra);
  }

  assistant(content: unknown[]): this {
    this.base('assistant', { message: { role: 'assistant', model: 'model-x', content } });
    return this;
  }

  text(text: string): this {
    return this.assistant([{ type: 'text', text }]);
  }

  thinking(text: string): this {
    return this.assistant([{ type: 'thinking', thinking: text, signature: 'sig' }]);
  }

  /** Tool-use ids are unique across builders, as in a real session. */
  toolCall(name: string, input: Rec, id = `toolu_${this.options.agentId ?? 'main'}_${String(this.seq + 1).padStart(4, '0')}`): string {
    this.assistant([{ type: 'tool_use', id, name, input }]);
    return id;
  }

  toolResult(id: string, toolUseResult: unknown, content: unknown, isError = false): this {
    return this.user([{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }], { toolUseResult });
  }

  /** An Agent call and its tool result: launched in the background, or a foreground run with its report. */
  agent(options: AgentOptions): string {
    const id = this.toolCall(
      'Agent',
      {
        description: options.description ?? 'Do a task',
        prompt: options.prompt ?? 'PROMPT GIVEN TO THE SUBAGENT',
        subagent_type: options.type ?? 'general-purpose',
      },
      options.toolUseId,
    );
    if (options.foreground !== undefined) {
      const content = [{ type: 'text', text: options.foreground.report }];
      this.toolResult(
        id,
        {
          status: 'completed',
          prompt: options.prompt ?? 'PROMPT GIVEN TO THE SUBAGENT',
          agentId: options.agentId,
          agentType: options.type ?? 'general-purpose',
          content,
          totalDurationMs: options.foreground.durationMs,
          totalTokens: 1234,
          totalToolUseCount: options.foreground.toolUses,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
        content,
      );
    } else {
      this.toolResult(
        id,
        {
          isAsync: true,
          status: 'async_launched',
          agentId: options.agentId,
          description: options.description ?? 'Do a task',
          prompt: options.prompt ?? 'PROMPT GIVEN TO THE SUBAGENT',
          outputFile: '/tmp/agent-output.txt',
          canReadOutputFile: true,
        },
        [{ type: 'text', text: 'Async agent launched successfully. agentId: ' + options.agentId }],
      );
    }
    return id;
  }

  notification(options: NotificationOptions): this {
    const usage =
      options.durationMs !== undefined
        ? `<usage><subagent_tokens>900</subagent_tokens><tool_uses>${String(options.toolUses ?? 0)}</tool_uses><duration_ms>${String(options.durationMs)}</duration_ms></usage>`
        : '';
    const text =
      `<task-notification>\n<task-id>${options.agentId}</task-id>\n` +
      (options.toolUseId !== undefined ? `<tool-use-id>${options.toolUseId}</tool-use-id>\n` : '') +
      `<output-file>/tmp/agent-output.txt</output-file>\n<status>${options.status}</status>\n<summary>Agent finished</summary>\n` +
      `<result>${options.result ?? 'NOTIFICATION RESULT TEXT'}</result>\n${usage}\n</task-notification>`;
    return this.user(text, { origin: { kind: 'task-notification' } });
  }

  handback(agentId: string, body: string): this {
    return this.user(`<peer-message>${body}</peer-message>`, {
      origin: { kind: 'peer', name: 'dev', senderTaskId: agentId, handback: true, body, from: 'agent:dev' },
    });
  }

  ask(questions: QuestionInput[]): string {
    return this.toolCall('AskUserQuestion', {
      questions: questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((label) => ({ label, description: `About ${label}` })),
      })),
    });
  }

  answer(id: string, questions: QuestionInput[], answers: Record<string, string>): this {
    return this.toolResult(
      id,
      {
        questions: questions.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options.map((label) => ({ label, description: '' })) })),
        answers,
        annotations: {},
      },
      'User has answered your questions.',
    );
  }

  aiTitle(title: string): this {
    this.records.push({ type: 'ai-title', aiTitle: title, sessionId: this.options.sessionId ?? 'session-0001' });
    return this;
  }

  jsonl(): string {
    return this.records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  }
}

export function transcript(options: TranscriptOptions = {}): TranscriptBuilder {
  return new TranscriptBuilder(options);
}

/** The `agent-<id>.meta.json` of a run. */
export function agentMeta(meta: { agentType: string; description?: string; spawnDepth?: number; parentAgentId?: string; toolUseId?: string }): Rec {
  return {
    agentType: meta.agentType,
    description: meta.description ?? 'Do a task',
    spawnDepth: meta.spawnDepth ?? 1,
    requestNonInteractive: true,
    requestShape: 'shape',
    ...(meta.parentAgentId !== undefined ? { parentAgentId: meta.parentAgentId } : {}),
    ...(meta.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
  };
}

export function chunkOf(text: string, offset = 0): { bytes: Buffer; offset: number; fileSize: number } {
  const bytes = Buffer.from(text, 'utf8');
  return { bytes: bytes.subarray(offset), offset, fileSize: bytes.length };
}

export interface DigestInput {
  main: TranscriptBuilder | string;
  sidechains?: Record<string, TranscriptBuilder | string>;
  metas?: Record<string, Rec>;
  active?: boolean;
  context?: Partial<DigestContext>;
}

/** The finalized digest of a main transcript, its metas and its sidechains, read in one go. */
export function digestOf(input: DigestInput): SessionDigest {
  const context: DigestContext = { repoRoot: '/work/shopfront', home: '/Users/robin', ...input.context };
  const text = (source: TranscriptBuilder | string): string => (typeof source === 'string' ? source : source.jsonl());
  const digest = emptyDigest();
  applyMainChunk(digest, chunkOf(text(input.main)), context);
  for (const [agentId, meta] of Object.entries(input.metas ?? {})) applyAgentMeta(digest, agentId, meta, context);
  for (const [agentId, side] of Object.entries(input.sidechains ?? {})) applySidechainChunk(digest, agentId, chunkOf(text(side)), context);
  return finalizeDigest(digest, { active: input.active ?? false, ...(context.limits !== undefined ? { limits: context.limits } : {}) });
}
