import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS companion_attachment_uploads (
      id TEXT PRIMARY KEY,
      attachment_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by_request_id TEXT,
      revoked_at TEXT,
      FOREIGN KEY (session_id) REFERENCES auth_sessions(session_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_companion_attachment_uploads_available
    ON companion_attachment_uploads(session_id, thread_id, consumed_at, revoked_at, expires_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_companion_attachment_uploads_cleanup
    ON companion_attachment_uploads(expires_at, consumed_at, revoked_at)
  `;
});
