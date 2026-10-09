// "Send review to the agent" (ADR-029), the pure part: the claude argv, the
// permission-mode allow-list, the session choice and the refusals.

import { describe, expect, it } from 'vitest';
import {
  AGENT_PERMISSION_MODES,
  agentLaunchSettings,
  agentRefusals,
  chooseSession,
  claudeArgs,
  displayArgv,
  lastJsonObject,
  resultSessionId,
  summaryHash,
  type AgentCheck,
  type AgentMode,
  type SessionCandidate,
} from '../../../src/core/agent/index.js';
import { emptySettings } from '../../../src/core/settings/index.js';

const SESSION = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const OTHER_SESSION = '11111111-2222-4333-8444-555555555555';
const TREE = '/work/sample-shop';
const CLAUDE = '/opt/tools/claude';

const candidate = (overrides: Partial<SessionCandidate> = {}): SessionCandidate => ({
  sessionId: SESSION,
  cwdReal: TREE,
  transcriptOk: true,
  title: 'Add totals',
  firstAt: '2026-09-01T10:00:00.000Z',
  lastAt: '2026-09-01T11:00:00.000Z',
  ...overrides,
});

describe('agent launch argv', () => {
  it('launch/argv-resume: --resume <id>, -p and the JSON output, the binary first', () => {
    const args = claudeArgs({ mode: 'resume', sessionId: SESSION, permissionMode: null });
    expect(args.tool).toBe('claude');
    expect(displayArgv(CLAUDE, args)).toEqual([CLAUDE, '--resume', SESSION, '-p', '--output-format', 'json']);
    expect(claudeArgs({ mode: 'resume', sessionId: SESSION, permissionMode: 'acceptEdits' }).argv).toEqual([
      '--resume',
      SESSION,
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
    ]);
  });

  it('launch/argv-new: -p and the JSON output, no session', () => {
    expect(claudeArgs({ mode: 'new', sessionId: null, permissionMode: null }).argv).toEqual(['-p', '--output-format', 'json']);
    expect(claudeArgs({ mode: 'new', sessionId: null, permissionMode: 'plan' }).argv).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'plan']);
    expect(() => claudeArgs({ mode: 'new', sessionId: SESSION, permissionMode: null })).toThrow(RangeError);
  });

  it('launch/argv-never-bypass: no settings combination produces a permission bypass', () => {
    const permissionValues: unknown[] = [
      undefined,
      null,
      ...AGENT_PERMISSION_MODES,
      'bypassPermissions',
      'BypassPermissions',
      'auto',
      'manual',
      'dontAsk',
      'default',
      '--dangerously-skip-permissions',
      'acceptEdits --dangerously-skip-permissions',
      ['acceptEdits'],
      true,
      1,
      '',
    ];
    const enabledValues: unknown[] = [undefined, true, false];
    const claudePaths: unknown[] = [undefined, null, CLAUDE, '--dangerously-skip-permissions'];
    const timeouts: unknown[] = [undefined, 1, 30, 120];
    const sessions: (string | null)[] = [null, SESSION, '--dangerously-skip-permissions', 'bypassPermissions'.padEnd(36, '-')];
    const modes: AgentMode[] = ['resume', 'new'];
    let built = 0;
    for (const permissionMode of permissionValues) {
      for (const enabled of enabledValues) {
        for (const claudePath of claudePaths) {
          for (const timeoutMinutes of timeouts) {
            const settings = { ...emptySettings(), agentLaunch: { enabled, repos: [TREE], claudePath, permissionMode, timeoutMinutes } };
            const parsed = agentLaunchSettings(settings);
            if (!parsed.ok) continue;
            for (const mode of modes) {
              for (const sessionId of sessions) {
                let argv: readonly string[];
                try {
                  argv = claudeArgs({ mode, sessionId: mode === 'new' ? null : sessionId, permissionMode: parsed.settings.permissionMode }).argv;
                } catch {
                  continue;
                }
                built++;
                for (const arg of argv) expect(arg).not.toMatch(/bypass|dangerously|skip-permissions/i);
                const permission = argv.indexOf('--permission-mode');
                if (permission !== -1) expect(['acceptEdits', 'plan']).toContain(argv[permission + 1]);
                expect(argv.filter((arg) => arg.startsWith('-'))).toEqual(
                  expect.arrayContaining(mode === 'resume' ? ['--resume', '-p', '--output-format'] : ['-p', '--output-format']) as unknown,
                );
              }
            }
          }
        }
      }
    }
    expect(built).toBeGreaterThan(0);
  });

  it('launch/permission-mode-allowlist: null, acceptEdits and plan only; anything else is a settings error', () => {
    for (const permissionMode of [null, undefined, 'acceptEdits', 'plan']) {
      const parsed = agentLaunchSettings({ ...emptySettings(), agentLaunch: { enabled: true, permissionMode } });
      expect(parsed.ok).toBe(true);
    }
    for (const permissionMode of ['bypassPermissions', 'auto', 'dontAsk', 'manual', 'ACCEPTEDITS', '', 3]) {
      const parsed = agentLaunchSettings({ ...emptySettings(), agentLaunch: { enabled: true, permissionMode } });
      expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('permissionMode') as unknown });
    }
    // The builder refuses it too, whatever reaches it.
    expect(() => claudeArgs({ mode: 'new', sessionId: null, permissionMode: 'bypassPermissions' as 'plan' })).toThrow(RangeError);
  });
});

describe('agent launch session choice', () => {
  it('launch/session-choice-newest-same-cwd: the newest session that ran in the working tree is resumed', () => {
    const older = candidate({ sessionId: OTHER_SESSION, lastAt: '2026-09-01T09:00:00.000Z' });
    const newest = candidate({ lastAt: '2026-09-01T12:00:00.000Z' });
    const elsewhere = candidate({ sessionId: '99999999-2222-4333-8444-555555555555', cwdReal: '/work/other', lastAt: '2026-09-01T13:00:00.000Z' });
    expect(chooseSession([older, elsewhere, newest], TREE)).toEqual({ mode: 'resume', session: newest });
  });

  it('launch/session-other-cwd-not-resumed: a session from another directory is never resumed; the reason is given', () => {
    expect(chooseSession([candidate({ cwdReal: '/work/sample-shop-wt' })], TREE)).toEqual({ mode: 'new', reason: 'session-other-directory' });
    expect(chooseSession([candidate({ cwdReal: null })], TREE)).toEqual({ mode: 'new', reason: 'session-other-directory' });
    expect(chooseSession([], TREE)).toEqual({ mode: 'new', reason: 'no-session-linked' });
    expect(chooseSession([candidate({ transcriptOk: false })], TREE)).toEqual({ mode: 'new', reason: 'transcript-gone' });
  });

  it('launch/session-id-format: only a lowercase 36-character id is resumed', () => {
    for (const sessionId of ['0F1E2D3C-4B5A-4968-8776-A5B4C3D2E1F0', 'abcdef01', `${SESSION}0`, '../../../etc/passwd-0000000000000000', '0f1e2d3c 4b5a-4968-8776-a5b4c3d2e1f0']) {
      expect(chooseSession([candidate({ sessionId })], TREE)).toEqual({ mode: 'new', reason: 'session-id-unsupported' });
      expect(() => claudeArgs({ mode: 'resume', sessionId, permissionMode: null })).toThrow(RangeError);
    }
  });
});

const allowed = (overrides: Partial<AgentCheck> = {}): AgentCheck => ({
  settings: { ok: true, settings: { enabled: true, repos: [TREE], claudePath: null, permissionMode: null, timeoutMinutes: 30 } },
  repoListed: true,
  archived: false,
  rewriteMarks: 1,
  note: null,
  workingTree: TREE,
  workingTreeExists: true,
  claude: { ok: true, path: CLAUDE },
  runInProgress: null,
  ...overrides,
});

const codes = (check: AgentCheck): string[] => agentRefusals(check).map((refusal) => refusal.code);

describe('agent launch refusals', () => {
  it('nothing refused when everything holds', () => {
    expect(agentRefusals(allowed())).toEqual([]);
    expect(codes(allowed({ rewriteMarks: 0, note: 'Rename the helpers.' }))).toEqual([]);
  });

  it('launch/no-working-tree-refused: a change not checked out anywhere is refused; a vanished tree too', () => {
    expect(codes(allowed({ workingTree: null, workingTreeExists: false, claude: null }))).toEqual(['no-working-tree']);
    expect(codes(allowed({ workingTreeExists: false }))).toEqual(['working-tree-missing']);
  });

  it('every refusal of ADR-029 that the facts decide', () => {
    expect(codes(allowed({ settings: { ok: true, settings: { enabled: false, repos: [], claudePath: null, permissionMode: null, timeoutMinutes: 30 } } }))).toEqual(['agent-launch-disabled']);
    expect(codes(allowed({ settings: { ok: false, error: 'bad' } }))).toEqual(['agent-launch-disabled']);
    expect(codes(allowed({ repoListed: false }))).toEqual(['agent-launch-disabled']);
    expect(codes(allowed({ rewriteMarks: 0, note: '  \n' }))).toEqual(['nothing-to-send']);
    expect(codes(allowed({ archived: true }))).toEqual(['archived']);
    expect(codes(allowed({ claude: { ok: false, why: 'missing', message: 'not found' } }))).toEqual(['claude-not-found']);
    expect(codes(allowed({ claude: { ok: false, why: 'in-repo', message: 'inside' } }))).toEqual(['claude-path-in-repo']);
    expect(codes(allowed({ runInProgress: 'change' }))).toEqual(['run-in-progress']);
    expect(codes(allowed({ runInProgress: 'daemon' }))).toEqual(['run-in-progress']);
  });
});

describe('agent launch result', () => {
  it('reads the session id of the last JSON object, and nothing from output that is not one', () => {
    const output = `noise\n{"type":"result","session_id":"${OTHER_SESSION}"}\nwarning on stderr\n`;
    expect(resultSessionId(lastJsonObject(output))).toBe(OTHER_SESSION);
    expect(resultSessionId(lastJsonObject('not json at all'))).toBeNull();
    expect(resultSessionId(lastJsonObject('{"session_id":"../x"}'))).toBeNull();
    expect(resultSessionId(lastJsonObject('{"session_id": 3}'))).toBeNull();
    expect(lastJsonObject('{"a":1}\n{"broken":')).toEqual({ a: 1 });
  });

  it('hashes the summary with sha256', () => {
    expect(summaryHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
