-- Idempotent ingest: the client's per-event UUID lands in client_id and the
-- unique index makes retried flushes store a row at most once. NULLs are
-- distinct in SQLite unique indexes, so #1265-era rows without an id are fine.
ALTER TABLE events ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_id ON events (client_id);
