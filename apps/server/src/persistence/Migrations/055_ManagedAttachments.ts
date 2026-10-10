import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS managed_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      owner_thread_id TEXT NOT NULL CHECK (length(owner_thread_id) > 0),
      owner_kind TEXT NOT NULL CHECK (length(owner_kind) > 0),
      owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
      kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
      original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 100),
      reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
      size_bytes INTEGER CHECK (
        size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= reserved_bytes)
      ),
      sha256 TEXT CHECK (
        sha256 IS NULL OR (
          length(sha256) = 64 AND
          sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      relative_path TEXT NOT NULL UNIQUE CHECK (
        length(relative_path) > 0 AND
        relative_path NOT LIKE '/%' AND
        relative_path NOT LIKE '../%' AND
        relative_path NOT LIKE '%/../%' AND
        instr(relative_path, char(0)) = 0
      ),
      state TEXT NOT NULL CHECK (
        state IN ('uploading', 'staged', 'claimed', 'deleting', 'deleted')
      ),
      staging_expires_at TEXT,
      claim_command_id TEXT,
      claim_message_id TEXT,
      claimed_at TEXT,
      delete_reason TEXT,
      delete_requested_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'uploading' AND size_bytes IS NULL AND sha256 IS NULL AND
          claim_command_id IS NULL AND claim_message_id IS NULL AND claimed_at IS NULL AND
          delete_reason IS NULL AND delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'staged' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND
          staging_expires_at IS NOT NULL AND claim_command_id IS NULL AND
          claim_message_id IS NULL AND claimed_at IS NULL AND
          delete_reason IS NULL AND delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'claimed' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND
          claim_command_id IS NOT NULL AND claim_message_id IS NOT NULL AND
          claimed_at IS NOT NULL AND delete_reason IS NULL AND
          delete_requested_at IS NULL AND deleted_at IS NULL) OR
        (state = 'deleting' AND delete_reason IS NOT NULL AND
          delete_requested_at IS NOT NULL AND deleted_at IS NULL) OR
        (state = 'deleted' AND delete_reason IS NOT NULL AND
          delete_requested_at IS NOT NULL AND deleted_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS managed_attachment_cleanup_jobs (
      attachment_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL CHECK (length(reason) > 0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (attachment_id)
        REFERENCES managed_attachment_blobs(attachment_id)
        ON DELETE CASCADE,
      CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_blobs_state_expiry
    ON managed_attachment_blobs(state, staging_expires_at, attachment_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_blobs_state_reserved
    ON managed_attachment_blobs(state, reserved_bytes)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_blobs_owner_thread
    ON managed_attachment_blobs(owner_thread_id, state, attachment_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_blobs_owner_principal
    ON managed_attachment_blobs(owner_kind, owner_id, state, attachment_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_blobs_claim
    ON managed_attachment_blobs(claim_command_id, claim_message_id, attachment_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_managed_attachment_cleanup_jobs_due
    ON managed_attachment_cleanup_jobs(next_attempt_at, lease_expires_at, attachment_id)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_managed_attachment_blobs_immutable_metadata
    BEFORE UPDATE OF
      owner_thread_id,
      owner_kind,
      owner_id,
      kind,
      original_name,
      mime_type,
      reserved_bytes,
      relative_path
    ON managed_attachment_blobs
    BEGIN
      SELECT RAISE(ABORT, 'managed attachment metadata is immutable');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_managed_attachment_blobs_immutable_content
    BEFORE UPDATE OF size_bytes, sha256
    ON managed_attachment_blobs
    WHEN
      (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS NOT OLD.size_bytes) OR
      (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256) OR
      ((OLD.size_bytes IS NULL OR OLD.sha256 IS NULL) AND NEW.state <> 'staged')
    BEGIN
      SELECT RAISE(ABORT, 'managed attachment content identity is immutable');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_managed_attachment_blobs_state_transition
    BEFORE UPDATE OF state
    ON managed_attachment_blobs
    WHEN NOT (
      NEW.state = OLD.state OR
      (OLD.state = 'uploading' AND NEW.state IN ('staged', 'deleting')) OR
      (OLD.state = 'staged' AND NEW.state IN ('claimed', 'deleting')) OR
      (OLD.state = 'claimed' AND NEW.state = 'deleting') OR
      (OLD.state = 'deleting' AND NEW.state = 'deleted')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid managed attachment state transition');
    END
  `;
});
