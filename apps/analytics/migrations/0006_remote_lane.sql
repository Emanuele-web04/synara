-- Synara Remote reports diagnostics alongside Beta. Existing rows are Beta.
ALTER TABLE events ADD COLUMN flavor TEXT NOT NULL DEFAULT 'beta';
CREATE INDEX IF NOT EXISTS idx_events_flavor_ts ON events (flavor, ts);

-- Product events gain the Remote channel, the daily active heartbeat and a fixed
-- failure category. SQLite cannot change CHECK constraints, so the table is rebuilt
-- with every existing row.
CREATE TABLE product_events_next (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  install_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote')),
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'ios', 'ipados')),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux', 'ios', 'ipados', 'other')),
  app_version TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'app.open', 'app.active', 'feature.used', 'connection.pair', 'connection.connect',
    'connection.reconnect', 'chat.request', 'turn.completed', 'performance.startup'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'cancelled')),
  feature TEXT CHECK (feature IS NULL OR feature IN (
    'chat', 'connections', 'inbox', 'tasks', 'hubs', 'browser', 'settings', 'search', 'project'
  )),
  mode TEXT CHECK (mode IS NULL OR mode IN ('local', 'remote')),
  provider TEXT CHECK (provider IS NULL OR provider IN ('codex', 'claude', 'other')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'unreachable', 'not_accepting', 'account_unavailable', 'host_unlinked', 'pairing_required',
    'incompatible', 'timeout', 'invalid_code', 'rejected', 'other'
  )),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (duration_ms BETWEEN 0 AND 86400000)),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR (input_tokens BETWEEN 0 AND 1000000000000)),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR (output_tokens BETWEEN 0 AND 1000000000000)),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR (cached_input_tokens BETWEEN 0 AND 1000000000000))
);

INSERT INTO product_events_next (
  event_id, ts, received_at, install_id, channel, surface, platform, app_version,
  event, outcome, feature, mode, provider, duration_ms,
  input_tokens, output_tokens, cached_input_tokens
)
SELECT
  event_id, ts, received_at, install_id, channel, surface, platform, app_version,
  event, outcome, feature, mode, provider, duration_ms,
  input_tokens, output_tokens, cached_input_tokens
FROM product_events;

DROP TABLE product_events;
ALTER TABLE product_events_next RENAME TO product_events;

CREATE INDEX IF NOT EXISTS idx_product_events_ts ON product_events (ts);
CREATE INDEX IF NOT EXISTS idx_product_events_received ON product_events (received_at);
CREATE INDEX IF NOT EXISTS idx_product_events_channel_surface_ts
  ON product_events (channel, surface, ts);
CREATE INDEX IF NOT EXISTS idx_product_events_event_ts ON product_events (event, ts);
CREATE INDEX IF NOT EXISTS idx_product_events_install_ts ON product_events (install_id, ts);

-- Finished turns per usage.daily window by fixed categories: provider, catalogued
-- model name, effort, interaction and permission mode, origin and outcome.
CREATE TABLE IF NOT EXISTS usage_turns (
  event_id INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  flavor TEXT NOT NULL DEFAULT 'beta',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  interaction_mode TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,
  origin TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_samples INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  token_samples INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_turns_day ON usage_turns (day);
CREATE INDEX IF NOT EXISTS idx_usage_turns_event ON usage_turns (event_id);
