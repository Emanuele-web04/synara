-- Reuse the existing aggregate store; diagnostic rolling samples stay separate.
ALTER TABLE usage_turns ADD COLUMN source TEXT NOT NULL DEFAULT 'diagnostic' CHECK (source IN ('diagnostic', 'product'));
ALTER TABLE usage_turns ADD COLUMN channel TEXT CHECK (channel IN ('stable', 'beta', 'remote'));
ALTER TABLE usage_turns ADD COLUMN input_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_turns ADD COLUMN output_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_turns ADD COLUMN cached_input_samples INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_usage_turns_product_dimensions ON usage_turns
  (day, channel, provider, model, effort, interaction_mode, runtime_mode, origin, outcome) WHERE source = 'product';
-- One daily hash is retained14days; no cross-day installation key is stored.
CREATE TABLE host_usage_receipts (window_id TEXT PRIMARY KEY CHECK (length(window_id) = 64), attempt_id TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX idx_host_usage_receipts_received ON host_usage_receipts (received_at);
CREATE TABLE host_usage_daily_quality (
  day TEXT NOT NULL, channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote')),
  report_windows INTEGER NOT NULL DEFAULT 0, partial_windows INTEGER NOT NULL DEFAULT 0,
  eligible_turns INTEGER NOT NULL DEFAULT 0, included_turns INTEGER NOT NULL DEFAULT 0,
  missing_completion_times INTEGER NOT NULL DEFAULT 0, token_truncated_turns INTEGER NOT NULL DEFAULT 0,
  capped_measurements INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, PRIMARY KEY (day, channel)
);
