-- Issue grouping key and triage state for the dashboard. An issue is one
-- error fingerprint, one crash process+reason, or one update failure step.
ALTER TABLE events ADD COLUMN issue_key TEXT GENERATED ALWAYS AS (
  CASE
    WHEN event = 'app.error' AND fingerprint <> '' THEN 'err:' || fingerprint
    WHEN event IN ('app.renderer-crash', 'app.child-process-crash') THEN 'crash:' || process_type || ':' || reason
    WHEN event = 'update.error' THEN 'update:' || error_context
  END
) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_events_issue_key_ts ON events (issue_key, ts);

-- No row means open. A resolved issue with events after updated_at shows as regressed.
CREATE TABLE IF NOT EXISTS issue_status (
  issue_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('resolved', 'ignored')),
  updated_at TEXT NOT NULL
);
