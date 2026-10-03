// GET /api/changes/:id/diff?path=<File.id>[&symbol=<Symbol.id>] (ADR-027): the
// diff of one file of the change's latest snapshot, computed by git in a
// worker, for the file view. The response is source code, so:
//
// - only paths and symbol ids that are in the snapshot are served (compared as
//   strings, before anything touches them); every byte comes through git;
// - a cross-site browser request is refused (403), on top of the Host check;
// - neither the path nor any content goes into a log line, only the change id.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../core/db/index.js';
import { unavailableFileDiff, type DiffJob } from '../../core/diff/index.js';
import type { Fingerprints } from '../../core/model/types.js';
import { languageForPath } from '../../core/parse/language.js';
import type { Report } from '../../core/report/types.js';
import { createDiffCache, type DiffCache } from '../diff/cache.js';
import type { DiffPool } from '../diff/pool.js';
import { HttpError } from '../http/errors.js';
import type { Logger } from '../log.js';
import { isSameOrigin } from './origin.js';
import { parseId, type Query } from './params.js';

export interface DiffDeps {
  db: Db;
  pool: DiffPool;
  /** The daemon's HTTP port, read per request. */
  port: () => number;
  log: Logger;
  cache?: DiffCache;
}

interface IdParams {
  id: string;
}

const SNAPSHOT_PREDATES = 'This snapshot predates the file view; a new one is being computed.';
const NO_WORKTREE = 'The working tree of this change is no longer there.';

function badRequest(message: string): HttpError {
  return new HttpError(400, 'bad-request', message);
}

/** A query value given once as a string, or undefined when absent. */
function single(name: string, value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) throw badRequest(`${name} must be given once`);
  return value;
}

/**
 * Defence in depth (ADR-027): membership already excludes these, but a value
 * with a NUL byte, a leading `/`, a `\` or a `.` or `..` segment is refused
 * before anything looks at it.
 */
export function checkPathShape(path: string): void {
  if (path === '' || path.includes('\0') || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '.' || part === '..')) {
    throw badRequest('path is not a path of the snapshot');
  }
}

/** The parsed fingerprints of the last snapshot read: parsing is per request otherwise, and they can be large. */
function memoFingerprints(): (json: string) => Fingerprints {
  let last: { json: string; parsed: Fingerprints } | null = null;
  return (json) => {
    if (last?.json !== json) last = { json, parsed: JSON.parse(json) as Fingerprints };
    return last.parsed;
  };
}

export function registerDiffRoute(http: FastifyInstance, deps: DiffDeps): void {
  const { db, pool, log } = deps;
  const cache = deps.cache ?? createDiffCache();
  const fingerprintsOf = memoFingerprints();

  http.get<{ Params: IdParams; Querystring: Query }>('/api/changes/:id/diff', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!isSameOrigin(request, deps.port())) {
      throw new HttpError(403, 'forbidden', 'the file view is for the daemon page only');
    }
    const id = parseId('id', request.params.id);
    const path = single('path', request.query.path);
    if (path === undefined) throw badRequest('path is required');
    checkPathShape(path);
    const symbol = single('symbol', request.query.symbol);
    if (symbol !== undefined && (symbol === '' || symbol.includes('\0'))) throw badRequest('symbol is not a symbol of the snapshot');

    const change = db.changes.get(id);
    if (change === null) throw new HttpError(404, 'not-found', `change ${String(id)} not found`);
    const meta = db.snapshots.latestMeta(id);
    if (meta === null) throw new HttpError(404, 'no-snapshot', `change ${String(id)} has no snapshot yet`);

    const notInSnapshot = (): HttpError => new HttpError(404, 'not-in-snapshot', 'that path is not in the latest snapshot of this change');
    const send = (json: string) => reply.type('application/json; charset=utf-8').send(json);

    if (meta.fingerprints === null) {
      // Written before schema v2: no fingerprints to check membership against, so the Report's own file ids.
      const report = db.snapshots.latestReport(id);
      const files = report === null ? [] : (JSON.parse(report) as Report).packages.flatMap((pkg) => pkg.files);
      if (!files.some((file) => file.id === path)) throw notInSnapshot();
      return send(JSON.stringify(unavailableFileDiff({ snapshotId: meta.id, head: meta.head, path, language: languageForPath(path) ?? 'other' }, SNAPSHOT_PREDATES)));
    }

    const fingerprints = fingerprintsOf(meta.fingerprints);
    // Own keys only: a path such as `constructor` is not in the snapshot.
    if (!Object.hasOwn(fingerprints.files, path)) throw notInSnapshot();
    if (symbol !== undefined && !(symbol.startsWith(`${path}#`) && Object.hasOwn(fingerprints.symbols, symbol))) throw notInSnapshot();

    const cached = cache.get({ changeId: id, snapshotId: meta.id, fingerprints: meta.fingerprints }, path, symbol);
    if (cached !== undefined) return send(cached);

    const repoDir = meta.dirty ? change.worktreePath : (db.repos.get(change.repoId)?.path ?? null);
    if (repoDir === null) {
      const language = languageForPath(path) ?? 'other';
      return send(JSON.stringify(unavailableFileDiff({ snapshotId: meta.id, head: meta.head, path, language }, NO_WORKTREE)));
    }
    const report = db.snapshots.latestReport(id);
    if (report === null) throw new HttpError(404, 'no-snapshot', `change ${String(id)} has no snapshot yet`);
    const job: DiffJob = {
      repoDir,
      snapshotId: meta.id,
      head: meta.head,
      mergeBase: meta.mergeBase,
      worktree: meta.dirty,
      path,
      fingerprint: fingerprints.files[path] as Fingerprints['files'][string],
      focus: symbol,
      reportJson: report,
    };
    let json: string;
    try {
      json = await pool.submit(`diff:${String(id)}:${String(meta.id)}:${path}\0${symbol ?? ''}`, 'high', job);
    } catch {
      // The change id and a code only: the message may carry a path.
      log.error(`diff: change ${String(id)} failed: job-failed`);
      throw new HttpError(500, 'internal', 'the diff could not be computed');
    }
    cache.set({ changeId: id, snapshotId: meta.id, fingerprints: meta.fingerprints }, path, symbol, json);
    return send(json);
  });
}
