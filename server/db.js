// SQLite storage (better-sqlite3). One file, persisted on a volume.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  rel_path TEXT,
  library_root TEXT,
  format TEXT NOT NULL,
  title TEXT,
  author TEXT,
  year TEXT,
  language TEXT,
  description TEXT,
  publisher TEXT,
  page_count INTEGER,
  cover_file TEXT,
  cover_source TEXT,
  size INTEGER,
  mtime INTEGER,
  missing INTEGER NOT NULL DEFAULT 0,
  scan_error TEXT,
  added_at INTEGER,
  updated_at INTEGER,
  edited_title INTEGER NOT NULL DEFAULT 0,
  edited_author INTEGER NOT NULL DEFAULT 0,
  edited_year INTEGER NOT NULL DEFAULT 0,
  edited_description INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_books_format ON books(format);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_missing ON books(missing);

CREATE TABLE IF NOT EXISTS reading_positions (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  progress REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * WAL needs shared-memory mmap on the database file. Some filesystems
 * (virtiofs, some network shares) refuse it, so probe on a throwaway file
 * before deciding the journal mode for the real database.
 */
function walIsSupported(dir) {
  const probe = path.join(dir, `.wal-probe-${process.pid}-${Date.now()}.db`);
  let probeDb = null;
  try {
    probeDb = new Database(probe);
    probeDb.pragma('journal_mode = WAL');
    probeDb.exec('CREATE TABLE probe(a)');
    return true;
  } catch {
    return false;
  } finally {
    try { probeDb?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${probe}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
  }
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const wal = walIsSupported(path.dirname(dbPath));
  if (!wal) console.warn('[db] WAL is not supported here; using the rollback journal');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma(wal ? 'journal_mode = WAL' : 'journal_mode = DELETE');
  if (wal) db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
