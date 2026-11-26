-- Capture the legacy diagnostic range without rewriting a potentially large event table.
-- Deploy the technical-only receiver first; actual deletion requires explicit operator opt-in.
CREATE TABLE diagnostic_content_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  through_event_id INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  through_status_rowid INTEGER NOT NULL,
  status_complete INTEGER NOT NULL DEFAULT 0 CHECK (status_complete IN (0, 1))
);
INSERT INTO diagnostic_content_cleanup (id, through_event_id, through_status_rowid)
SELECT 1, COALESCE((SELECT MAX(id) FROM events), 0), COALESCE((SELECT MAX(rowid) FROM issue_status), 0);
