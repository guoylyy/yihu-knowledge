import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  title TEXT,
  excerpt TEXT,
  frontmatter_json TEXT,
  is_denied INTEGER NOT NULL DEFAULT 0,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  sensitive_kinds TEXT,
  words INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_dir ON files(dir);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY,
  src_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_text TEXT NOT NULL,
  target_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS links_src ON links(src_id);
CREATE INDEX IF NOT EXISTS links_target ON links(target_id);
CREATE TABLE IF NOT EXISTS tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS file_text (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  title, path, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  via TEXT NOT NULL,
  username TEXT,
  user_id TEXT,
  ip TEXT,
  ua TEXT,
  result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  last_fail INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
  path TEXT NOT NULL,
  password_hash TEXT,
  allow_sensitive INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  path TEXT,
  ip TEXT,
  ua TEXT,
  referer TEXT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_share ON visits(share_id, ts);
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  path TEXT NOT NULL,
  chars INTEGER NOT NULL,
  is_selection INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  answer TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`;
const AI_LOG_ADDED = { mode: 'TEXT', model: 'TEXT', ms: 'INTEGER' };
const SESSIONS_ADDED = { login_via: "TEXT NOT NULL DEFAULT 'password'", username: 'TEXT', user_id: 'TEXT' };

function addColumns(db, table, added) {
  const columns = db.pragma(`table_info(${table})`).map((c) => c.name);
  for (const [name, type] of Object.entries(added)) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'kb.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  db.exec(SCHEMA);
  addColumns(db, 'ai_log', AI_LOG_ADDED);
  addColumns(db, 'sessions', SESSIONS_ADDED);
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key) ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
