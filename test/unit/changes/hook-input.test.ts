// The Claude Code Stop hook JSON that `track --agent` reads from stdin
// (SPEC.md section 3, ADR-001): session_id, transcript_path and cwd, at most 64 KB.

import { describe, expect, it } from 'vitest';
import { MAX_HOOK_INPUT_BYTES, parseAgentHookInput } from '../../../src/core/changes/hook-input.js';

const valid = {
  session_id: 'session-0001',
  transcript_path: '/work/sample-shop/.transcripts/session-0001.jsonl',
  cwd: '/work/sample-shop/src',
  hook_event_name: 'Stop',
  stop_hook_active: false,
};

describe('parseAgentHookInput', () => {
  it('reads session_id, transcript_path and cwd and ignores the other fields', () => {
    expect(parseAgentHookInput(JSON.stringify(valid))).toEqual({
      ok: true,
      input: {
        sessionId: 'session-0001',
        transcriptPath: '/work/sample-shop/.transcripts/session-0001.jsonl',
        cwd: '/work/sample-shop/src',
      },
    });
  });

  it('treats empty or blank input as no hook input', () => {
    expect(parseAgentHookInput('')).toEqual({ ok: true, input: null });
    expect(parseAgentHookInput(' \n\t')).toEqual({ ok: true, input: null });
  });

  it('refuses input over 64 KB', () => {
    const padded = JSON.stringify({ ...valid, padding: 'x'.repeat(MAX_HOOK_INPUT_BYTES) });
    expect(MAX_HOOK_INPUT_BYTES).toBe(64 * 1024);
    expect(parseAgentHookInput(padded)).toEqual({ ok: false, error: `hook input exceeds ${String(MAX_HOOK_INPUT_BYTES)} bytes` });
  });

  it('counts bytes, not characters', () => {
    // 3 bytes per character in UTF-8: under the limit in characters, over it in bytes.
    const text = JSON.stringify({ ...valid, padding: '€'.repeat(30_000) });
    expect(text.length).toBeLessThan(MAX_HOOK_INPUT_BYTES);
    expect(parseAgentHookInput(text).ok).toBe(false);
  });

  it.each([
    ['not json', 'hook input is not valid JSON'],
    ['[1, 2]', 'hook input must be a JSON object'],
    ['null', 'hook input must be a JSON object'],
    [JSON.stringify({ ...valid, session_id: '' }), 'hook input: session_id must be a non-empty string'],
    [JSON.stringify({ ...valid, session_id: 7 }), 'hook input: session_id must be a non-empty string'],
    [JSON.stringify({ ...valid, transcript_path: 'relative/session.jsonl' }), 'hook input: transcript_path must be an absolute path'],
    [JSON.stringify({ ...valid, cwd: undefined }), 'hook input: cwd must be an absolute path'],
    [JSON.stringify({ ...valid, cwd: 'src' }), 'hook input: cwd must be an absolute path'],
  ])('rejects %s', (text, error) => {
    expect(parseAgentHookInput(text)).toEqual({ ok: false, error });
  });
});
