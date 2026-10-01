// A second process on the daemon's database file, for db-concurrency.test.ts.
// argv: <dist db index URL> <db path> <mode> <repoId | holdMs>
//
// Modes:
// - `reader`: opens through openDb (pragmas + the migrate transaction) like any
//   diffcity process would, then reads the stores in a loop;
// - `raw-reader`: a plain readonly connection reading in short read transactions;
// - `lock-holder`: takes the write lock (BEGIN IMMEDIATE) for `holdMs`, as
//   openDb's migrate transaction does for a moment, then commits.
//
// Readers print `ready` once open and loop until stdin closes; every mode ends
// with one JSON line: { reads, errors, opened }.

import { createRequire } from 'node:module';

const [distIndex, dbPath, mode, arg] = process.argv.slice(2);
const errors = [];
let reads = 0;
let opened = false;
let stop = false;

function record(error) {
  errors.push({ code: error?.code ?? null, message: String(error?.message ?? error) });
}

function finish() {
  process.stdout.write(`${JSON.stringify({ reads, errors, opened })}\n`);
}

const require = createRequire(distIndex);

if (mode === 'lock-holder') {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { timeout: 5000 });
  db.exec('BEGIN IMMEDIATE');
  opened = true;
  process.stdout.write('ready\n');
  setTimeout(() => {
    try {
      db.exec('COMMIT');
      db.close();
    } catch (error) {
      record(error);
    }
    finish();
  }, Number(arg));
} else {
  const repoId = Number(arg);
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => {
    stop = true;
  });

  let readOnce;
  let close;
  try {
    if (mode === 'reader') {
      const { openDb } = await import(distIndex);
      const db = openDb(dbPath);
      readOnce = () => {
        db.repos.listSummaries();
        db.changes.listLiveSummaries(repoId);
        for (const change of db.changes.listLive(repoId)) db.snapshots.latestReport(change.id);
        db.events.listForRepo(repoId);
      };
      close = () => db.close();
    } else {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true, timeout: 5000 });
      const reports = db.prepare(
        'SELECT length(s.report) AS n FROM snapshots s JOIN changes c ON c.id = s.changeId WHERE c.repoId = ?',
      );
      const events = db.prepare('SELECT count(*) AS n FROM events WHERE repoId = ?');
      // A read transaction spanning several statements sees one consistent snapshot.
      const readTx = db.transaction(() => {
        reports.all(repoId);
        events.get(repoId);
      });
      readOnce = () => readTx();
      close = () => db.close();
    }
    opened = true;
  } catch (error) {
    record(error);
  }

  process.stdout.write('ready\n');

  while (opened && !stop) {
    try {
      readOnce();
      reads += 1;
    } catch (error) {
      record(error);
    }
    // Yield so stdin's end can be observed.
    await new Promise((resolve) => setImmediate(resolve));
  }

  try {
    close?.();
  } catch (error) {
    record(error);
  }
  finish();
}
