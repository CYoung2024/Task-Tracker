import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  notes       TEXT    NOT NULL DEFAULT '',
  days        TEXT    NOT NULL DEFAULT '0123456', -- weekday digits, 0 = Sunday
  remind_at   TEXT,                              -- 'HH:MM' local time: "time to do it" ping
  due_by      TEXT,                              -- 'HH:MM' local time: overdue ping if not done
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS routine_completions (
  routine_id   INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  date         TEXT    NOT NULL,                 -- 'YYYY-MM-DD' local date
  completed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (routine_id, date)
);

CREATE TABLE IF NOT EXISTS todos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  notes        TEXT    NOT NULL DEFAULT '',
  due_at       TEXT,                             -- ISO timestamp (UTC)
  remind_at    TEXT,                             -- ISO timestamp (UTC)
  completed_at TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,           -- lowest shows first
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per notification already sent, so restarts and overlapping ticks never double-ping.
CREATE TABLE IF NOT EXISTS sent_notifications (
  key      TEXT PRIMARY KEY,
  sent_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'tasks.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Bring databases created by older versions up to the current schema. */
function migrate(db) {
  const todoColumns = db.prepare('PRAGMA table_info(todos)').all().map((c) => c.name);
  if (!todoColumns.includes('sort_order')) {
    // Seed from the old automatic order so existing lists don't get shuffled.
    transaction(db, () => {
      db.exec(`
        ALTER TABLE todos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
        UPDATE todos SET sort_order = ranked.position
        FROM (
          SELECT id, ROW_NUMBER() OVER (ORDER BY due_at IS NULL, due_at, created_at DESC) AS position
          FROM todos
        ) AS ranked
        WHERE todos.id = ranked.id;
      `);
    });
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/** Run fn inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
