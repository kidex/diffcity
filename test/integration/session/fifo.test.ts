// A FIFO where a transcript, a subagent file or a meta file is expected
// (ADR-038): the reader checks each derived file with lstat and opens with
// O_NONBLOCK, so a FIFO is skipped at once and never blocks a thread of the
// libuv pool. Proven in a child process running the built reader: the digest
// completes and the process exits on its own. Temporary directories only.

import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { subagentsDir } from '../../../src/core/session/index.js';
import { agentMeta, transcript } from '../../helpers/transcript.js';

const ID = '0a1b2c3d-0000-4000-8000-000000000051';
const job = fileURLToPath(new URL('../../../dist/core/session/job.js', import.meta.url));

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() ?? '', { recursive: true, force: true });
});

async function project(): Promise<{ projects: string; path: string; subagents: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-fifo-')));
  dirs.push(root);
  const projects = join(root, 'projects');
  const path = join(projects, '-work-shopfront', `${ID}.jsonl`);
  const subagents = subagentsDir(path);
  await mkdir(subagents, { recursive: true });
  return { projects, path, subagents };
}

const mkfifo = (path: string): void => {
  execFileSync('mkfifo', [path]);
};

/** Runs the built runSessionJob in a fresh process; resolves with its JSON result, or rejects when the process does not exit in time. */
function runJobInChild(input: object): Promise<Record<string, unknown>> {
  const script = `import { runSessionJob } from ${JSON.stringify(job)};\nconst result = await runSessionJob(${JSON.stringify(input)});\nprocess.stdout.write(JSON.stringify(result));\n`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(`the reader process did not finish: ${error.message}`));
        return;
      }
      resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

describe('session/fifo-never-blocks', () => {
  it('a FIFO as the subagent file or as the meta file is skipped; the digest completes and the process exits', async () => {
    const { projects, path, subagents } = await project();
    const main = transcript({ sessionId: ID }).prompt('Two runs');
    main.agent({ agentId: 'a1', type: 'dev' });
    main.agent({ agentId: 'a2', type: 'dev' });
    await writeFile(path, main.jsonl());
    mkfifo(join(subagents, 'agent-a1.jsonl'));
    mkfifo(join(subagents, 'agent-a2.meta.json'));
    await writeFile(join(subagents, 'agent-a1.meta.json'), JSON.stringify(agentMeta({ agentType: 'meta-type' })));
    await writeFile(join(subagents, 'agent-a2.jsonl'), transcript({ sessionId: ID, agentId: 'a2' }).text('A2 report').jsonl());

    const result = await runJobInChild({ sessionId: ID, transcriptPath: path, projectsDir: projects, previous: null, repoRoot: '/work/shopfront', active: true });
    expect(result.ok).toBe(true);
    const digest = JSON.parse(String(result.digest)) as { runs: { agentId: string; type: string | null; report: string | null }[] };
    expect(digest.runs.map((run) => [run.agentId, run.type, run.report])).toEqual([
      ['a1', 'meta-type', null],
      ['a2', 'dev', 'A2 report'],
    ]);
  });

  it('a FIFO in place of the main transcript (swapped in after validation) reads nothing; the process exits', async () => {
    const { projects, path } = await project();
    mkfifo(path);
    // The worker's own check refuses it before any open.
    expect(await runJobInChild({ sessionId: ID, transcriptPath: path, projectsDir: projects, previous: null, repoRoot: null, active: true })).toEqual({ ok: false, code: 'not-a-file' });
    // The reader itself, called past that check (the race window), skips it without blocking.
    const read = fileURLToPath(new URL('../../../dist/core/session/read.js', import.meta.url));
    const script = `import { readSessionDigest } from ${JSON.stringify(read)};\nconst d = await readSessionDigest({ transcriptPath: ${JSON.stringify(path)}, active: true, repoRoot: null });\nprocess.stdout.write(JSON.stringify({ parsed: d.state.main.parsedBytes, prompts: d.prompts.length }));\n`;
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (error !== null) reject(new Error(`the reader process did not finish: ${error.message}`));
        else resolve(stdout);
      });
    });
    expect(JSON.parse(out)).toEqual({ parsed: 0, prompts: 0 });
  });
});
