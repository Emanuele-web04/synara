import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Provider message ids are only stable inside their owning thread. Rebuild the
 * projection table around that durable identity so a provider may reuse an id
 * in another thread without moving or overwriting the original message.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS projection_thread_messages_v57`;
  yield* sql`
    CREATE TABLE projection_thread_messages_v57 (
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attachments_json TEXT,
      source TEXT NOT NULL DEFAULT 'native',
      skills_json TEXT,
      mentions_json TEXT,
      dispatch_mode TEXT,
      dispatch_origin TEXT,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_v57 (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at,
      attachments_json,
      source,
      skills_json,
      mentions_json,
      dispatch_mode,
      dispatch_origin
    )
    SELECT
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      is_streaming,
      created_at,
      updated_at,
      attachments_json,
      source,
      skills_json,
      mentions_json,
      dispatch_mode,
      dispatch_origin
    FROM projection_thread_messages
  `;

  yield* sql`DROP TABLE projection_thread_messages`;
  yield* sql`
    ALTER TABLE projection_thread_messages_v57
    RENAME TO projection_thread_messages
  `;

  yield* sql`
    CREATE INDEX idx_projection_thread_messages_message_id
    ON projection_thread_messages(message_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_created_desc
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_profile_prompt_activity
    ON projection_thread_messages(role, source, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_role_created_desc
    ON projection_thread_messages(thread_id, role, created_at DESC, message_id DESC)
  `;
});
