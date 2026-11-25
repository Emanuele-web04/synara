-- Public GitHub aggregate counters only; no names, URLs or installation identifiers.
CREATE TABLE installer_download_snapshots (
  observed_at TEXT PRIMARY KEY,
  previous_observed_at TEXT UNIQUE
);

-- Reject stale/concurrent writers before any head/history mutation in the D1 batch.
CREATE TRIGGER installer_download_snapshot_order BEFORE INSERT ON installer_download_snapshots
WHEN NEW.observed_at <= COALESCE((SELECT MAX(observed_at) FROM installer_download_snapshots), '')
  OR COALESCE(NEW.previous_observed_at, '') <> COALESCE((SELECT MAX(observed_at) FROM installer_download_snapshots), '')
BEGIN
  SELECT RAISE(ABORT, 'stale installer download snapshot');
END;

CREATE TABLE installer_download_assets (
  asset_id INTEGER PRIMARY KEY CHECK (asset_id > 0),
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote', 'other')),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  downloads INTEGER NOT NULL CHECK (downloads >= 0)
);

CREATE TABLE installer_download_history (
  observed_at TEXT NOT NULL REFERENCES installer_download_snapshots(observed_at) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'remote', 'other')),
  platform TEXT NOT NULL CHECK (platform IN ('darwin', 'win32', 'linux')),
  total INTEGER NOT NULL CHECK (total >= 0),
  downloads INTEGER CHECK (downloads >= 0),
  PRIMARY KEY (observed_at, channel, platform)
);
