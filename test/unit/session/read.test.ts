// Reading a session from disk (ADR-038): the main transcript, the subagents
// directory next to it, nested runs, and resuming from the stored cursors.
// Everything lives in a temporary directory, never the real ~/.claude.

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionDigest, readTranscriptChunk, subagentsDir, type SessionDigest } from '../../../src/core/session/index.js';
import { agentMeta, transcript } from '../../helpers/transcript.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'diffcity-session-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('session read', () => {
  it('session/read-main-sidechains-and-nested-runs-then-resume', async () => {
    const path = join(dir, 'projects', '-work-shopfront', 'session-0001.jsonl');
    const subagents = subagentsDir(path);
    expect(subagents).toBe(join(dir, 'projects', '-work-shopfront', 'session-0001', 'subagents'));
    await mkdir(subagents, { recursive: true });

    const main = transcript().prompt('Ship the cart badge');
    main.agent({ agentId: 'lead1', type: 'lead' });
    const lead = transcript({ agentId: 'lead1', start: '2026-09-01T09:01:00.000Z' });
    lead.agent({ agentId: 'dev1', type: 'dev' });
    const dev = transcript({ agentId: 'dev1', start: '2026-09-01T09:02:00.000Z' });
    dev.toolCall('Edit', { file_path: '/work/shopfront/src/badge.ts' });
    dev.text('Badge done');

    await writeFile(path, main.jsonl());
    await writeFile(join(subagents, 'agent-lead1.jsonl'), lead.jsonl());
    await writeFile(join(subagents, 'agent-lead1.meta.json'), JSON.stringify(agentMeta({ agentType: 'lead', spawnDepth: 1 })));
    await writeFile(join(subagents, 'agent-dev1.jsonl'), dev.jsonl());
    await writeFile(join(subagents, 'agent-dev1.meta.json'), JSON.stringify(agentMeta({ agentType: 'dev', spawnDepth: 2, parentAgentId: 'lead1' })));

    const context = { repoRoot: '/work/shopfront', home: '/Users/robin' };
    const first = await readSessionDigest({ transcriptPath: path, active: true, ...context });
    expect(first.runs.map((run) => [run.agentId, run.parentAgentId, run.spawnDepth, run.status])).toEqual([
      ['lead1', null, 1, 'running'],
      ['dev1', 'lead1', 2, 'running'],
    ]);
    expect(first.runs[1]?.report).toBe('Badge done');
    expect(first.files).toEqual(['src/badge.ts']);

    // The session goes on: appended lines are read from the stored cursors.
    const more = transcript({ start: '2026-09-01T10:00:00.000Z' }).prompt('Now the checkout');
    more.handback('lead1', 'Lead report');
    await appendFile(path, more.jsonl());
    const stored = JSON.parse(JSON.stringify(first)) as SessionDigest;
    const second = await readSessionDigest({ transcriptPath: path, active: false, previous: stored, ...context });
    expect(second.prompts.map((prompt) => prompt.text)).toEqual(['Ship the cart badge', 'Now the checkout']);
    expect(second.runs.map((run) => [run.agentId, run.report, run.status])).toEqual([
      ['lead1', 'Lead report', 'completed'],
      ['dev1', 'Badge done', 'unknown'],
    ]);
    expect(second.files).toEqual(['src/badge.ts']);
  });

  it('session/read-chunk-stops-at-the-limit', async () => {
    const path = join(dir, 'big.jsonl');
    await writeFile(path, 'a'.repeat(100));
    expect(await readTranscriptChunk(path, 10, { transcriptBytes: 64 })).toMatchObject({ offset: 10, fileSize: 100 });
    expect((await readTranscriptChunk(path, 10, { transcriptBytes: 64 }))?.bytes.length).toBe(54);
    expect(await readTranscriptChunk(join(dir, 'missing.jsonl'), 0)).toBeNull();
  });
});
