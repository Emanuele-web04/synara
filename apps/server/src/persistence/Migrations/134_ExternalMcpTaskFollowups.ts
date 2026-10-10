import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Follow-ups never enter creation recovery: they cannot compensate an existing
  // thread or worktree. The original task operation remains the capacity owner.
  yield* sql`
    CREATE TABLE IF NOT EXISTS external_mcp_task_followups (
      run_id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES external_mcp_integrations(integration_id),
      request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      task_operation_id TEXT NOT NULL REFERENCES external_mcp_operations(operation_id),
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      command_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'dispatching', 'accepted', 'failed')),
      error_code TEXT,
      turn_id TEXT,
      terminal_state TEXT CHECK (terminal_state IN ('completed', 'error', 'interrupted')),
      created_at TEXT NOT NULL,
      UNIQUE (integration_id, request_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_followups_task
    ON external_mcp_task_followups(integration_id, task_operation_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_mcp_followups_turn
    ON external_mcp_task_followups(thread_id, turn_id)
  `;
  // Remember authoritative acceptance and terminal state in the same commit as
  // their source. Later transcript rollback/pruning must not resurrect a claim
  // or let an edited message rebind the old request to its replacement turn.
  for (const mutation of ["INSERT", "UPDATE"] as const) {
    yield* sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS external_mcp_followup_turn_${mutation.toLowerCase()}
      AFTER ${mutation} ON projection_turns
      WHEN NEW.turn_id IS NOT NULL
      BEGIN
        UPDATE external_mcp_task_followups
        SET turn_id = COALESCE(turn_id, NEW.turn_id),
            terminal_state = COALESCE(terminal_state,
              CASE WHEN NEW.state IN ('completed', 'error', 'interrupted') THEN NEW.state END)
        WHERE thread_id = NEW.thread_id
          AND (turn_id = NEW.turn_id OR (turn_id IS NULL AND message_id = NEW.pending_message_id));
      END
    `);
  }
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS external_mcp_followup_message_binding
    AFTER INSERT ON orchestration_events
    WHEN NEW.event_type = 'thread.message-sent'
      AND json_extract(NEW.payload_json, '$.role') = 'user'
      AND json_extract(NEW.payload_json, '$.turnId') IS NOT NULL
    BEGIN
      UPDATE external_mcp_task_followups
      SET turn_id = COALESCE(turn_id, json_extract(NEW.payload_json, '$.turnId')),
          terminal_state = COALESCE(terminal_state, (
            SELECT state FROM projection_turns
            WHERE thread_id = NEW.stream_id
              AND turn_id = json_extract(NEW.payload_json, '$.turnId')
              AND state IN ('completed', 'error', 'interrupted')
          ))
      WHERE thread_id = NEW.stream_id
        AND message_id = json_extract(NEW.payload_json, '$.messageId')
        AND (turn_id IS NULL OR turn_id = json_extract(NEW.payload_json, '$.turnId'));
    END
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_bound_user_message
    ON orchestration_events(stream_id, json_extract(payload_json, '$.messageId'), sequence)
    WHERE event_type = 'thread.message-sent'
      AND json_extract(payload_json, '$.role') = 'user'
      AND json_extract(payload_json, '$.turnId') IS NOT NULL
  `;

  // Resolve only this message's acceptance. The first durable binding survives
  // later edits and native steer shares its actual provider turn, never latest.
  // Provider failure becomes terminal only with a correlated rejection AND a
  // settled delivery; dead/uncertain delivery retains capacity until reconciled.
  yield* sql`DROP VIEW IF EXISTS external_mcp_task_followup_states`;
  yield* sql`
    CREATE VIEW external_mcp_task_followup_states AS
    WITH requests AS (
      SELECT followups.run_id, followups.integration_id, followups.request_id, followups.fingerprint,
        followups.task_operation_id, followups.thread_id, followups.message_id, followups.command_id,
        followups.mode, followups.status, followups.error_code, followups.created_at, followups.terminal_state,
        receipts.status AS receipt_status,
        COALESCE(
          followups.turn_id,
          (
            SELECT json_extract(events.payload_json, '$.turnId')
            FROM orchestration_events AS events
            WHERE events.stream_id = followups.thread_id
              AND events.event_type = 'thread.message-sent'
              AND json_extract(events.payload_json, '$.role') = 'user'
              AND json_extract(events.payload_json, '$.messageId') = followups.message_id
              AND json_extract(events.payload_json, '$.turnId') IS NOT NULL
            ORDER BY events.sequence ASC LIMIT 1
          ),
          messages.turn_id,
          (
            SELECT turns.turn_id FROM projection_turns AS turns
            WHERE turns.thread_id = followups.thread_id
              AND turns.pending_message_id = followups.message_id
              AND turns.turn_id IS NOT NULL
            ORDER BY turns.requested_at ASC, turns.turn_id ASC LIMIT 1
          )
        ) AS turn_id,
        (
          SELECT MIN(events.sequence) FROM orchestration_events AS events
          WHERE events.command_id = followups.command_id
        ) AS source_sequence
      FROM external_mcp_task_followups AS followups
      LEFT JOIN orchestration_command_receipts AS receipts ON receipts.command_id = followups.command_id
      LEFT JOIN projection_thread_messages AS messages
        ON messages.thread_id = followups.thread_id AND messages.message_id = followups.message_id
    ), deliveries AS (
      SELECT requests.*, (
        SELECT MAX(events.sequence) FROM orchestration_events AS events
        WHERE events.aggregate_kind = 'thread' AND events.stream_id = requests.thread_id
          AND events.sequence >= requests.source_sequence
          AND (
            (events.event_type IN ('thread.turn-start-requested', 'thread.turn-queued')
              AND json_extract(events.payload_json, '$.messageId') = requests.message_id)
            OR (events.event_type = 'thread.claude-cache-response-requested'
              AND json_extract(events.payload_json, '$.review.messageId') = requests.message_id)
          )
      ) AS delivery_sequence
      FROM requests
    ), evidence AS (
      SELECT deliveries.*, COALESCE(deliveries.terminal_state, turns.state) AS turn_state,
        delivery.state AS delivery_state,
        (
          SELECT reconciliation.outcome FROM provider_delivery_reconciliations AS reconciliation
          WHERE reconciliation.consumer_name = 'provider-command-reactor.v1'
            AND reconciliation.event_sequence = deliveries.delivery_sequence
          ORDER BY reconciliation.reconciled_at DESC, reconciliation.reconciliation_id DESC LIMIT 1
        ) AS reconciliation_outcome,
        EXISTS (
          SELECT 1 FROM queued_turn_promotions AS queue
          WHERE queue.thread_id = deliveries.thread_id AND queue.message_id = deliveries.message_id
            AND queue.state = 'cancelled'
        ) AS queue_cancelled,
        EXISTS (
          SELECT 1 FROM orchestration_events AS events
          WHERE events.sequence = deliveries.delivery_sequence
            AND events.event_type = 'thread.claude-cache-response-requested'
            AND json_extract(events.payload_json, '$.decision') = 'cancel'
        ) AS review_cancelled,
        EXISTS (
          SELECT 1 FROM projection_thread_activities AS activities
          WHERE activities.thread_id = deliveries.thread_id
            AND activities.kind = 'provider.turn.start.failed'
            AND json_extract(activities.payload_json, '$.messageId') = deliveries.message_id
            AND json_extract(activities.payload_json, '$.sourceEventSequence') = deliveries.delivery_sequence
            AND json_extract(activities.payload_json, '$.settlementStatus') = 'rejected'
        ) AS provider_rejected
      FROM deliveries
      LEFT JOIN projection_turns AS turns ON turns.thread_id = deliveries.thread_id AND turns.turn_id = deliveries.turn_id
      LEFT JOIN orchestration_event_deliveries AS delivery
        ON delivery.consumer_name = 'provider-command-reactor.v1' AND delivery.event_sequence = deliveries.delivery_sequence
    ), states AS (
      SELECT evidence.*,
        CASE
          WHEN status = 'failed' OR receipt_status = 'rejected' THEN 'error'
          WHEN turn_id IS NOT NULL THEN COALESCE(turn_state, 'pending')
          WHEN reconciliation_outcome = 'abandon' THEN 'interrupted'
          WHEN delivery_state = 'succeeded' AND reconciliation_outcome IS NOT 'accepted'
            AND (queue_cancelled OR review_cancelled) THEN 'interrupted'
          WHEN delivery_state = 'succeeded' AND reconciliation_outcome IS NOT 'accepted'
            AND provider_rejected THEN 'error'
          ELSE 'pending'
        END AS state
      FROM evidence
    )
    SELECT run_id, thread_id, turn_id, state,
      state IN ('pending', 'running') AND (
        delivery_state IN ('dead', 'uncertain')
        OR (turn_id IS NULL AND reconciliation_outcome = 'accepted')
        OR (status = 'dispatching' AND receipt_status IS NULL AND error_code = 'dispatch_uncertain')
      ) AS blocked,
      CASE
        WHEN status = 'failed' OR receipt_status = 'rejected' THEN COALESCE(error_code, 'dispatch_rejected')
        WHEN state = 'completed' THEN NULL
        WHEN state = 'interrupted' THEN 'request_cancelled'
        WHEN state = 'error' THEN CASE WHEN turn_id IS NULL THEN 'provider_rejected' ELSE 'turn_failed' END
        WHEN delivery_state IN ('dead', 'uncertain') OR (turn_id IS NULL AND reconciliation_outcome = 'accepted') THEN 'provider_delivery_blocked'
        WHEN status = 'dispatching' AND receipt_status IS NULL THEN error_code
        ELSE NULL
      END AS error_code
    FROM states
  `;

  // Preserve migration 132's recovery and latest-turn rules. A terminal follow-up
  // can additionally retire its own stale pending placeholder, never another run.
  yield* sql`DROP VIEW IF EXISTS external_mcp_active_capacity_claims`;
  yield* sql`
    CREATE VIEW external_mcp_active_capacity_claims AS
    SELECT operations.integration_id, operations.operation_id
    FROM external_mcp_operations AS operations
    WHERE operations.status IN ('reserved', 'dispatching', 'compensating')

    UNION

    SELECT tasks.integration_id, tasks.operation_id
    FROM external_mcp_tasks AS tasks
    INNER JOIN external_mcp_operations AS operations
      ON operations.operation_id = tasks.operation_id
    WHERE tasks.status IN ('planned', 'created', 'failed')
      AND COALESCE((
        SELECT CASE
          WHEN turns.state IN ('pending', 'running') THEN turns.state
          WHEN sessions.status = 'error' THEN 'error'
          WHEN sessions.status IN ('interrupted', 'stopped') THEN 'interrupted'
          WHEN EXISTS (
            SELECT 1
            FROM projection_turns AS pending_turns
            WHERE pending_turns.thread_id = threads.thread_id
              AND pending_turns.turn_id IS NULL
              AND pending_turns.state = 'pending'
              AND pending_turns.pending_message_id IS NOT NULL
              AND pending_turns.checkpoint_turn_count IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM external_mcp_task_followups AS followups
                JOIN external_mcp_task_followup_states AS states ON states.run_id = followups.run_id
                WHERE followups.thread_id = pending_turns.thread_id
                  AND followups.message_id = pending_turns.pending_message_id
                  AND states.state IN ('completed', 'error', 'interrupted')
              )
              AND (turns.requested_at IS NULL OR pending_turns.requested_at >= turns.requested_at)
          ) THEN 'pending'
          ELSE COALESCE(
            turns.state,
            CASE
              WHEN tasks.status = 'failed' AND operations.status <> 'compensating'
                THEN 'completed'
              ELSE 'pending'
            END
          )
        END
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        LEFT JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = COALESCE(
           threads.latest_turn_id,
           (
             SELECT latest.turn_id
             FROM projection_turns AS latest
             WHERE latest.thread_id = threads.thread_id
               AND latest.turn_id IS NOT NULL
             ORDER BY latest.requested_at DESC, latest.turn_id DESC
             LIMIT 1
           )
         )
        WHERE threads.thread_id = tasks.thread_id
        LIMIT 1
      ), CASE
        WHEN tasks.status = 'failed' AND operations.status <> 'compensating' THEN 'completed'
        ELSE 'pending'
      END) IN ('pending', 'running')

    UNION

    SELECT followups.integration_id, followups.task_operation_id AS operation_id
    FROM external_mcp_task_followups AS followups
    JOIN external_mcp_task_followup_states AS states ON states.run_id = followups.run_id
    WHERE states.state IN ('pending', 'running')
  `;
});
