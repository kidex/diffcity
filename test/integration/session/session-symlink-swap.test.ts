// A stored session whose transcript is later replaced by a symbolic link
// (ADR-038, team lead decision on validation refusals): the next Stop is
// refused by code, and the session is then served as unreadable with no
// digest, never with the content read before the swap. Invented repo and
// transcript under temporary directories.

import { mkdir, realpath, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../helpers/daemon.js';
import { transcript } from '../../helpers/transcript.js';
import { cleanupAfterEach, sampleRepo } from '../collect/collect-helpers.js';
import { claudeDir, sessionDaemon, sessionId, type ClaudeDir } from './session-helpers.js';

cleanupAfterEach();

const claudes: ClaudeDir[] = [];
afterEach(async () => {
  for (const claude of claudes.splice(0)) await claude.cleanup();
});

interface View {
  sessionId: string;
  unreadable: boolean;
  stale: boolean;
  digest: unknown;
}

describe('session refusals after a stored read', () => {
  it('session/symlink-swap-next-stop-unreadable: a transcript replaced by a symlink is refused at the next Stop and served unreadable with no digest', async () => {
    const repo = await sampleRepo();
    await repo.branch('feature/cart');
    await repo.commit('count the cart', { 'src/cart/count.ts': 'export const count = (items: number[]): number => items.length;\n' });
    const dir = await realpath(repo.dir);
    const claude = await claudeDir();
    claudes.push(claude);
    const daemon = await sessionDaemon(claude);
    const id = sessionId(77);
    const path = await claude.write(id, transcript({ sessionId: id, cwd: dir }).prompt('PROMPT READ BEFORE THE SWAP'));
    const hook = { sessionId: id, transcriptPath: path, cwd: dir, event: 'Stop' };

    await daemon.hook(dir, hook);
    const row = await daemon.until(id, (current) => current.digest !== null && daemon.db.sessions.links(current.id).length === 1);
    const changeId = daemon.db.sessions.links(row.id)[0]?.changeId ?? 0;
    const route = `/api/changes/${String(changeId)}/sessions`;
    const before = (await (await daemon.get(route)).json()) as { sessions: View[] };
    expect(before.sessions[0]).toMatchObject({ sessionId: id, unreadable: false });
    expect(JSON.stringify(before.sessions[0]?.digest)).toContain('PROMPT READ BEFORE THE SWAP');

    // The transcript becomes a symbolic link to a copy outside the projects directory.
    const outside = join(claude.dir, 'outside');
    await mkdir(outside, { recursive: true });
    await rename(path, join(outside, `${id}.jsonl`));
    await symlink(join(outside, `${id}.jsonl`), path);

    await daemon.hook(dir, hook, '2026-09-01T12:05:00.000Z');
    await daemon.settle();
    await waitFor(() => daemon.log.lines.some((line) => line === 'warn session refused: symlink'), 10_000, 'the symlink refusal');
    await daemon.settle();

    const after = (await (await daemon.get(route)).json()) as { sessions: View[] };
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]).toMatchObject({ sessionId: id, unreadable: true, stale: false, digest: null });
    expect(JSON.stringify(after)).not.toContain('PROMPT READ BEFORE THE SWAP');
  });
});
