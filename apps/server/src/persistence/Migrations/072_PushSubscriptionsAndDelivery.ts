import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      endpoint_hash TEXT NOT NULL,
      encrypted_subscription TEXT NOT NULL,
      preview_enabled INTEGER NOT NULL DEFAULT 1,
      platform TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      FOREIGN KEY (session_id) REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      UNIQUE(session_id, transport, endpoint_hash)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active
    ON push_subscriptions(session_id, disabled_at, transport)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_notifications (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL UNIQUE,
      thread_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      preview TEXT,
      deep_link TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_push_notifications_expiry
    ON push_notifications(expires_at, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_deliveries (
      notification_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error_code TEXT,
      delivered_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(notification_id, subscription_id),
      FOREIGN KEY (notification_id) REFERENCES push_notifications(id) ON DELETE CASCADE,
      FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_push_deliveries_pending
    ON push_deliveries(status, next_attempt_at, attempts)
  `;
});
