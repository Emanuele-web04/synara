-- Opt-in product usage events. This table is independent of diagnostic
-- reports and contains only the bounded fields accepted by worker.ts.
CREATE TABLE IF NOT EXISTS product_events (
  event_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL,
  install_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'ios', 'ipados')),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux', 'ios', 'ipados', 'other')),
  app_version TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN (
    'app.open', 'feature.used', 'connection.pair', 'connection.connect',
    'connection.reconnect', 'chat.request', 'turn.completed', 'performance.startup'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'cancelled')),
  feature TEXT CHECK (feature IS NULL OR feature IN (
    'chat', 'connections', 'inbox', 'tasks', 'hubs', 'browser', 'settings', 'search', 'project'
  )),
  mode TEXT CHECK (mode IS NULL OR mode IN ('local', 'remote')),
  provider TEXT CHECK (provider IS NULL OR provider IN ('codex', 'claude', 'other')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR (duration_ms BETWEEN 0 AND 86400000)),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR (input_tokens BETWEEN 0 AND 1000000000000)),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR (output_tokens BETWEEN 0 AND 1000000000000)),
  cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR (cached_input_tokens BETWEEN 0 AND 1000000000000))
);

CREATE INDEX IF NOT EXISTS idx_product_events_ts ON product_events (ts);
CREATE INDEX IF NOT EXISTS idx_product_events_received ON product_events (received_at);
CREATE INDEX IF NOT EXISTS idx_product_events_channel_surface_ts
  ON product_events (channel, surface, ts);
CREATE INDEX IF NOT EXISTS idx_product_events_event_ts ON product_events (event, ts);
