-- Synara Beta diagnostics event store.
-- Columns match the allowlist in worker.ts normalizeEvent; free-text columns
-- (message, stack, log_tail) hold already-redacted text.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  process_type TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  error_context TEXT NOT NULL DEFAULT '',
  target_version TEXT NOT NULL DEFAULT '',
  duration_ms REAL,
  source TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  message TEXT,
  stack TEXT,
  log_tail TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_event ON events (event);
CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events (fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_app_version ON events (app_version);

-- Index of minidumps stored in the synara-beta-crash-dumps R2 bucket.
CREATE TABLE IF NOT EXISTS crash_dumps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key TEXT NOT NULL,
  install_id TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crash_dumps_ts ON crash_dumps (ts);
CREATE INDEX IF NOT EXISTS idx_crash_dumps_install ON crash_dumps (install_id);
