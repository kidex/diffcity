// Cmd+K search (SPEC.md section 6, ADR-017), computed in the daemon, never in
// the UI. The match is case-insensitive over repo names, the refs and titles of
// live changes and the touched paths of their latest snapshots. A prefix match
// ranks above a substring match; within each of the two groups repos come
// first, then changes, then files, each in corpus order.

import type { Db } from '../db/index.js';
import type { ChangeKind, SearchResult } from '../model/types.js';

/** Longer queries are cut to this many characters. */
export const MAX_QUERY_LENGTH = 200;

export interface SearchRepo {
  id: number;
  name: string;
  path: string;
}

export interface SearchChange {
  id: number;
  repoId: number;
  kind: ChangeKind;
  /** `branch:<name>`, `pr:<number>` or `draft:<worktree>` (ADR-019). */
  ref: string;
  prNumber: number | null;
  title: string;
}

/** The touched paths of a live change's latest snapshot. */
export interface SearchFiles {
  repoId: number;
  changeId: number;
  paths: string[];
}

/** What search runs over; the order of each list is the order of the results inside a group. */
export interface SearchCorpus {
  repos: SearchRepo[];
  changes: SearchChange[];
  files: SearchFiles[];
}

type Match = 'prefix' | 'substring' | null;

/** `prefix` when one of `prefixes` starts with `q`, `substring` when `haystack` contains it. */
function match(q: string, prefixes: readonly string[], haystacks: readonly string[]): Match {
  if (prefixes.some((value) => value.toLowerCase().startsWith(q))) return 'prefix';
  if (haystacks.some((value) => value.toLowerCase().includes(q))) return 'substring';
  return null;
}

/** The searchable name of a ref: the branch name; a draft's worktree path is not searchable. */
function refName(change: SearchChange): string | null {
  if (change.kind === 'draft') return null;
  if (change.kind === 'pr' && change.prNumber !== null) return `#${String(change.prNumber)}`;
  const colon = change.ref.indexOf(':');
  return colon === -1 ? change.ref : change.ref.slice(colon + 1);
}

/** `Draft`, `Branch <name>` or `PR #N`, as shown next to a change. */
function changeLabel(change: SearchChange): string {
  if (change.kind === 'draft') return 'Draft';
  const name = refName(change) ?? '';
  return change.kind === 'pr' ? `PR ${name}` : `Branch ${name}`;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Lowercased, trimmed and cut to MAX_QUERY_LENGTH. */
export function normalizeQuery(query: string): string {
  return query.slice(0, MAX_QUERY_LENGTH).trim().toLowerCase();
}

/** The ranked results for `query`, at most `limit`. A blank query has none. */
export function searchCorpus(corpus: SearchCorpus, query: string, limit: number): SearchResult[] {
  const q = normalizeQuery(query);
  if (q === '' || limit <= 0) return [];

  const prefix: SearchResult[][] = [[], [], []];
  const substring: SearchResult[][] = [[], [], []];
  const add = (found: Match, kind: 0 | 1 | 2, result: SearchResult): void => {
    if (found === 'prefix') prefix[kind]?.push(result);
    else if (found === 'substring') substring[kind]?.push(result);
  };

  const repoNames = new Map(corpus.repos.map((repo) => [repo.id, repo.name]));
  const changes = new Map(corpus.changes.map((change) => [change.id, change]));

  for (const repo of corpus.repos) {
    add(match(q, [repo.name], [repo.name]), 0, { kind: 'repo', label: repo.name, detail: repo.path, repoId: repo.id });
  }
  for (const change of corpus.changes) {
    const name = refName(change);
    const fields = name === null ? [change.title] : [change.title, name];
    add(match(q, fields, fields), 1, {
      kind: 'change',
      label: change.title,
      detail: `${repoNames.get(change.repoId) ?? ''}, ${changeLabel(change)}`,
      repoId: change.repoId,
      changeId: change.id,
    });
  }
  for (const files of corpus.files) {
    const change = changes.get(files.changeId);
    const detail = `${repoNames.get(files.repoId) ?? ''}, ${change?.title ?? ''}`;
    for (const path of files.paths) {
      add(match(q, [path, basename(path)], [path]), 2, {
        kind: 'file',
        label: path,
        detail,
        repoId: files.repoId,
        changeId: files.changeId,
        path,
      });
    }
  }

  return [...prefix.flat(), ...substring.flat()].slice(0, limit);
}

/**
 * The corpus from the database: repos in Fleet order (latest event first),
 * their live changes by latest event, and the touched paths of each live
 * change's latest snapshot.
 */
export function loadSearchCorpus(db: Db): SearchCorpus {
  const repos = db.repos.listSummaries().map(({ id, name, path }) => ({ id, name, path }));
  const changes: SearchChange[] = repos.flatMap((repo) =>
    db.changes.listLiveSummaries(repo.id).map(({ id, repoId, kind, ref, prNumber, title }) => ({ id, repoId, kind, ref, prNumber, title })),
  );
  const touched = new Map(db.snapshots.liveTouched().map((entry) => [entry.changeId, entry]));
  const files: SearchFiles[] = [];
  for (const change of changes) {
    const entry = touched.get(change.id);
    if (entry !== undefined) files.push({ repoId: change.repoId, changeId: change.id, paths: entry.touched });
  }
  return { repos, changes, files };
}

/** Search over the database. */
export function search(db: Db, query: string, limit: number): SearchResult[] {
  if (normalizeQuery(query) === '') return [];
  return searchCorpus(loadSearchCorpus(db), query, limit);
}
