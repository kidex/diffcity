// One invented session read from disk with every kind of run at once: a
// background run that hands back, one that ends with a notification, a
// foreground run and a nested run, plus prompts carrying fake secrets and an
// IDE-injected block. Then the files grow (a record split across two reads)
// and the digest resumes from its cursors. Everything lives in a temporary
// directory, never the real ~/.claude.

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionDigest, subagentsDir, type SessionDigest } from '../../../src/core/session/index.js';
import { agentMeta, transcript } from '../../helpers/transcript.js';

const HOME = '/home/someone';
const REPO = '/work/ledger';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffcity-session-mixed-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const copy = (digest: SessionDigest): SessionDigest => JSON.parse(JSON.stringify(digest)) as SessionDigest;

describe('session read, mixed session', () => {
  it('session/read-mixed-session-redacted-statuses-then-resume', async () => {
    const path = join(dir, 'projects', '-work-ledger', 'session-0001.jsonl');
    const subagents = subagentsDir(path);
    await mkdir(subagents, { recursive: true });

    // Fake secrets built at run time: the repo's guards block literal ones.
    const token = ['gh', 'p_', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'].join('');
    const basic = Buffer.from('ledger-user:not-a-real-pass').toString('base64');
    const dashes = '-'.repeat(5);
    const pem = `${dashes}BEGIN EC PRIVATE KEY${dashes}\nMHcCAQEEINVENTEDKEYMATERIAL\n${dashes}END EC PRIVATE KEY${dashes}`;

    const opts = { cwd: REPO, branch: 'feat/ledger' };
    const main = transcript(opts)
      .prompt(`Push with ${token}`)
      .prompt(`curl -H "Authorization: Basic ${basic}" https://api.example.test`)
      .prompt(`Key:\n${pem}\ndone`)
      .prompt(`Open ${HOME}/notes/ledger.txt`)
      .user([
        { type: 'text', text: `<ide_opened_file>The user opened ${HOME}/IDE_ONLY.ts</ide_opened_file>` },
        { type: 'text', text: 'Rename the total' },
      ])
      .text('MAIN ASSISTANT TEXT')
      .thinking('MAIN THINKING');
    const edit = main.toolCall('Edit', { file_path: `${REPO}/src/total.ts`, old_string: 'a', new_string: 'b' });
    main.toolResult(edit, {}, 'EDIT TOOL OUTPUT');
    main.toolCall('Write', { file_path: `${HOME}/outside.txt`, content: 'WRITTEN CONTENT' });
    main.agent({ agentId: 'hand1', type: 'dev-core', toolUseId: 'toolu_hand1', prompt: 'PROMPT TO HAND1' });
    main.agent({ agentId: 'note1', type: 'reviewer', toolUseId: 'toolu_note1', prompt: 'PROMPT TO NOTE1' });
    main.agent({ agentId: 'fore1', type: 'Explore', prompt: 'PROMPT TO FORE1', foreground: { report: 'Foreground found it', durationMs: 4200, toolUses: 3 } });
    main.handback('hand1', 'Hand1 report');
    main.notification({ agentId: 'note1', toolUseId: 'toolu_note1', status: 'failed', durationMs: 9000, toolUses: 7, result: 'NOTIFICATION RESULT' });
    main.aiTitle('Ledger total rename');

    const hand = transcript({ ...opts, agentId: 'hand1', start: '2026-09-01T09:01:00.000Z' }).prompt('PROMPT TO HAND1');
    hand.toolCall('Edit', { file_path: `${REPO}/src/a.ts` });
    hand.agent({ agentId: 'nest1', type: 'Explore', prompt: 'PROMPT TO NEST1' });
    hand.text('HAND1 LAST TEXT');
    const note = transcript({ ...opts, agentId: 'note1', start: '2026-09-01T09:01:00.000Z' }).prompt('PROMPT TO NOTE1');
    note.toolCall('Grep', { pattern: 'x' });
    const nest = transcript({ ...opts, agentId: 'nest1', start: '2026-09-01T09:02:00.000Z' }).prompt('PROMPT TO NEST1');
    nest.toolCall('Write', { file_path: `${REPO}/docs/n.md` });
    nest.wait(2000).text('Nested report');

    await writeFile(path, main.jsonl());
    await writeFile(join(subagents, 'agent-hand1.jsonl'), hand.jsonl());
    await writeFile(join(subagents, 'agent-hand1.meta.json'), JSON.stringify(agentMeta({ agentType: 'dev-core', spawnDepth: 1 })));
    await writeFile(join(subagents, 'agent-note1.jsonl'), note.jsonl());
    await writeFile(join(subagents, 'agent-note1.meta.json'), JSON.stringify(agentMeta({ agentType: 'reviewer', spawnDepth: 1 })));
    await writeFile(join(subagents, 'agent-nest1.jsonl'), nest.jsonl());
    await writeFile(join(subagents, 'agent-nest1.meta.json'), JSON.stringify(agentMeta({ agentType: 'Explore', spawnDepth: 2, parentAgentId: 'hand1' })));

    const first = await readSessionDigest({ transcriptPath: path, repoRoot: REPO, home: HOME, active: true });

    expect(first.prompts.map((p) => p.text)).toEqual([
      'Push with [redacted:github-token]',
      'curl -H "Authorization: Basic [redacted:basic-auth]" https://api.example.test',
      'Key:\n[redacted:private-key]\ndone',
      'Open ~/notes/ledger.txt',
      'Rename the total',
    ]);
    expect(first.title).toBe('Ledger total rename');
    expect(first.branch).toBe('feat/ledger');
    const byId = (d: SessionDigest, id: string) => d.runs.find((run) => run.agentId === id);
    expect(byId(first, 'hand1')).toMatchObject({ status: 'completed', statusSource: 'handback', report: 'Hand1 report', type: 'dev-core' });
    expect(byId(first, 'note1')).toMatchObject({ status: 'failed', statusSource: 'notification', durationMs: 9000, durationApproximate: false, toolUses: 7 });
    expect(byId(first, 'fore1')).toMatchObject({ status: 'completed', foreground: true, report: 'Foreground found it', durationMs: 4200, toolUses: 3 });
    expect(byId(first, 'nest1')).toMatchObject({ status: 'running', parentAgentId: 'hand1', spawnDepth: 2, report: 'Nested report', reportSource: 'sidechain', durationApproximate: true });
    expect(first.main.counts).toMatchObject({ edit: 2, subagents: 3 });
    expect(first.main.outsideFiles).toBe(1);
    expect(first.files).toEqual(['src/total.ts', 'src/a.ts', 'docs/n.md']);

    const serialized = JSON.stringify(first);
    for (const leak of [token, basic, 'INVENTEDKEYMATERIAL', 'someone', 'IDE_ONLY', 'MAIN ASSISTANT', 'MAIN THINKING', 'EDIT TOOL OUTPUT', 'WRITTEN CONTENT', 'PROMPT TO', 'NOTIFICATION RESULT', 'HAND1 LAST TEXT']) {
      expect(serialized).not.toContain(leak);
    }

    // The files grow: one complete prompt, an edit, half of a third record; a sidechain gets a shell call.
    const more = transcript({ ...opts, start: '2026-09-01T10:00:00.000Z' }).prompt('Second round');
    more.toolCall('Edit', { file_path: `${REPO}/src/new.ts` });
    more.prompt('Third round');
    const [secondLine = '', editLine = '', thirdLine = ''] = more.jsonl().split('\n');
    const cut = Math.floor(thirdLine.length / 2);
    await appendFile(path, `${secondLine}\n${editLine}\n${thirdLine.slice(0, cut)}`);
    const sideMore = transcript({ ...opts, agentId: 'note1', start: '2026-09-01T10:00:00.000Z' });
    sideMore.toolCall('Bash', { command: 'ls' });
    await appendFile(join(subagents, 'agent-note1.jsonl'), sideMore.jsonl());

    const second = await readSessionDigest({ transcriptPath: path, repoRoot: REPO, home: HOME, active: false, previous: copy(first) });
    expect(second.prompts.map((p) => p.text).slice(5)).toEqual(['Second round']);
    expect(second.files).toEqual(['src/total.ts', 'src/a.ts', 'docs/n.md', 'src/new.ts']);
    expect(second.main.counts.edit).toBe(3);
    expect(byId(second, 'note1')?.activity.counts).toMatchObject({ 'read-search': 1, shell: 1 });
    expect(byId(second, 'nest1')?.status).toBe('unknown');
    expect(second.badLines).toBe(0);

    await appendFile(path, `${thirdLine.slice(cut)}\n`);
    const third = await readSessionDigest({ transcriptPath: path, repoRoot: REPO, home: HOME, active: false, previous: copy(second) });
    expect(third.prompts.map((p) => p.text).slice(5)).toEqual(['Second round', 'Third round']);
    expect(third.badLines).toBe(0);

    // Nothing new: reading again changes nothing.
    const again = await readSessionDigest({ transcriptPath: path, repoRoot: REPO, home: HOME, active: false, previous: copy(third) });
    expect(again).toEqual(third);
  });
});
