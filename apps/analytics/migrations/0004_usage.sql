-- Anonymous Beta usage: app.start carries OS version and language; usage.daily
-- carries project/thread counts plus per-provider rows; beta.installed and
-- beta.left reuse events.outcome.
ALTER TABLE events ADD COLUMN os_version TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN locale TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN projects INTEGER;
ALTER TABLE events ADD COLUMN active_threads INTEGER;

-- One row per provider per usage.daily event, swept with events by received_at.
CREATE TABLE IF NOT EXISTS usage_providers (
  event_id INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  threads INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  turns_failed INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  PRIMARY KEY (event_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_usage_providers_day ON usage_providers (day);
CREATE INDEX IF NOT EXISTS idx_usage_providers_received ON usage_providers (received_at);
