import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { LiveActivityHostSnapshot } from "@synara/contracts";
import {
  accountApiIssuer,
  accountStateDirectory,
  readAccountFile,
  resolveEnvironmentId,
} from "./accountAuth";
import { mintHostProof, readHostIdentity } from "./hostIdentity";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "./persistence/Services/ProviderRuntimeEvents";

const RecoveryLink = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  resetAt: Schema.String,
  autoResume: Schema.Literal(true),
  state: Schema.optional(Schema.Literals(["waiting", "resuming"])),
  resumedTurnId: Schema.optional(Schema.String),
});
type RecoveryLink = typeof RecoveryLink.Type;
type ReportedTurn = LiveActivityHostSnapshot["turns"][number];

function recoveryLink(json: string | null): RecoveryLink | undefined {
  if (!json || json.length > 32_768) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return Schema.is(RecoveryLink)(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readWatchedTurn(
  sql: SqlClient.SqlClient,
  watch: { readonly threadId: string; readonly turnId: string },
  sequence: number,
) {
  return Effect.gen(function* () {
    const [thread] = yield* sql<{
      recovery: string | null;
      cancelledTurnId: string | null;
      archivedAt: string | null;
      deletedAt: string | null;
    }>`SELECT usage_limit_recovery_json AS recovery,
      usage_limit_recovery_cancelled_turn_id AS cancelledTurnId,
      archived_at AS archivedAt, deleted_at AS deletedAt
      FROM projection_threads WHERE thread_id=${watch.threadId}`;
    const current = recoveryLink(thread?.recovery ?? null);
    if (thread?.recovery != null && current === undefined)
      return { ...watch, state: "stopped" } satisfies ReportedTurn;
    let effectiveTurnId = watch.turnId;
    const seen = new Set<string>();
    let recovering = false;
    const stopped = (): ReportedTurn => ({ ...watch, state: "stopped" });
    // Each hop is an indexed lookup of a server-authored source -> admitted-turn link.
    // A damaged/cyclic or >64-hop chain retires quietly; it never revives the source failure.
    for (let hop = 0; hop < 64; hop++) {
      if (seen.has(effectiveTurnId)) return stopped();
      seen.add(effectiveTurnId);
      if (thread?.archivedAt || thread?.deletedAt) return stopped();
      const [turn] = yield* sql<{
        state: string;
        startedAt: string;
        approval: number;
        input: number;
      }>`SELECT t.state, COALESCE(t.started_at,t.requested_at) AS startedAt,
        EXISTS(SELECT 1 FROM projection_pending_interactions a WHERE a.thread_id=t.thread_id
          AND a.turn_id=t.turn_id AND a.status='pending' AND a.interaction_kind='approval') AS approval,
        EXISTS(SELECT 1 FROM projection_pending_interactions a WHERE a.thread_id=t.thread_id
          AND a.turn_id=t.turn_id AND a.status='pending' AND a.interaction_kind='userInput') AS input
        FROM projection_turns t WHERE t.thread_id=${watch.threadId} AND t.turn_id=${effectiveTurnId}`;
      if (!turn)
        return current?.resumedTurnId === effectiveTurnId && current.state === "resuming"
          ? ({ ...watch, effectiveTurnId, state: "resuming" } satisfies ReportedTurn)
          : recovering
            ? stopped()
            : undefined;
      // A later human message also stamps cancellation. It cannot undo a turn
      // that already completed; failed quota sources still retire quietly.
      if (thread?.cancelledTurnId === effectiveTurnId && turn.state !== "completed")
        return stopped();
      const binding = effectiveTurnId !== watch.turnId ? { effectiveTurnId } : {};
      const live = turn.state === "running";
      if (!live && current?.resumedTurnId === effectiveTurnId && current.state === "resuming") {
        return { ...watch, ...binding, state: "resuming" } satisfies ReportedTurn;
      }
      if (!live && thread) {
        let link = current?.turnId === effectiveTurnId ? current : undefined;
        if (!link) {
          const [row] = yield* sql<{ recovery: string | null }>`
            SELECT json_extract(payload_json,'$.usageLimitRecovery') AS recovery
            FROM orchestration_events
            WHERE aggregate_kind='thread' AND event_type='thread.meta-updated'
              AND json_type(payload_json,'$.usageLimitRecovery')='object'
              AND stream_id=${watch.threadId}
              AND json_extract(payload_json,'$.usageLimitRecovery.turnId')=${effectiveTurnId}
              AND sequence<=${sequence}
            ORDER BY sequence DESC LIMIT 1`;
          link = recoveryLink(row?.recovery ?? null);
          if (row?.recovery != null && link === undefined) return stopped();
        }
        if (link) {
          recovering = true;
          if (link.resumedTurnId) {
            effectiveTurnId = link.resumedTurnId;
            continue;
          }
          if (current?.id !== link.id) return stopped();
          const reset = Date.parse(link.resetAt) / 1_000;
          return Number.isFinite(reset) && reset >= 0
            ? ({
                ...watch,
                ...binding,
                state: link.state === "resuming" ? "resuming" : "usageLimit",
                ...(link.state === "resuming" ? {} : { usageLimitResetAt: reset }),
              } satisfies ReportedTurn)
            : stopped();
        }
      }
      if (!live) {
        const [ingestion] = yield* sql<{ pending: number }>`SELECT EXISTS(
          SELECT 1 FROM provider_runtime_events
          WHERE thread_id=${watch.threadId} AND turn_id=${effectiveTurnId}
            AND sequence>COALESCE((SELECT last_acked_sequence FROM provider_runtime_event_consumers
              WHERE consumer_name=${PROVIDER_RUNTIME_INGESTION_CONSUMER}),0)
            AND event_type IN ('turn.completed','turn.aborted','runtime.error','session.exited')
          LIMIT 1) AS pending`;
        // The turn projection may settle before ingestion commits quota admission.
        // Never publish its final failure while that exact terminal row is unacked.
        if (ingestion?.pending)
          return { ...watch, ...binding, state: "resuming" } satisfies ReportedTurn;
      }
      const state = live
        ? turn.approval
          ? "needsApproval"
          : turn.input
            ? "needsInput"
            : "running"
        : turn.state === "completed"
          ? "ready"
          : turn.state === "error"
            ? "failed"
            : "stopped";
      const startedAt = Date.parse(turn.startedAt) / 1_000;
      return Number.isFinite(startedAt)
        ? ({ ...watch, ...binding, state, startedAt } satisfies ReportedTurn)
        : undefined;
    }
    return stopped();
  });
}

/** ActivityKit and completion alerts share this exact-turn projection poll.
 * The durable sequence fences out-of-order reports; later polls repair uploads.
 * APNs credentials never reach this process. */
export function createAccountLiveActivityReporter(options: {
  baseDir: string;
  devUrl?: URL;
  hostIdentityPath: string;
  sql: SqlClient.SqlClient;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  async function sync() {
    if (!isServerBetaFeatureEnabled("remoteConnections")) return 60000;
    const account = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
    if (!account?.hostId || account.hostKeyGeneration === undefined) return 60000;
    const identity = await readHostIdentity(options.hostIdentityPath);
    if (!identity) return 60000;
    const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
    const proof = await mintHostProof({
      identity,
      environmentId,
      hostId: account.hostId,
      keyGeneration: account.hostKeyGeneration,
      apiIssuer: accountApiIssuer(account.accountUrl),
    });
    const url = `${accountApiIssuer(account.accountUrl)}/hosts/${encodeURIComponent(account.hostId)}/live-activities`;
    const headers = { authorization: `HostProof ${proof}`, "content-type": "application/json" };
    const response = await fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) return 60000;
    const body: unknown = await response.json();
    const WatchList = Schema.Struct({
      turns: Schema.Array(Schema.Struct({ threadId: Schema.String, turnId: Schema.String })).check(
        Schema.isMaxLength(256),
      ),
    });
    if (!Schema.is(WatchList)(body) || body.turns.length === 0) return 15000;
    const sql = options.sql;
    const snapshot = await Effect.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          const [projection] = yield* sql<{
            sequence: number;
          }>`SELECT last_applied_sequence AS sequence FROM projection_state WHERE projector='projection.hot'`;
          const turns: Array<LiveActivityHostSnapshot["turns"][number]> = [];
          for (const watch of body.turns) {
            const turn = yield* readWatchedTurn(sql, watch, projection?.sequence ?? 0);
            if (turn) turns.push(turn);
          }
          return Schema.decodeUnknownSync(LiveActivityHostSnapshot)({
            sequence: projection?.sequence ?? 0,
            turns,
          });
        }),
      ),
    );
    const current = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
    if (
      stopped ||
      current?.hostId !== account.hostId ||
      current.hostKeyGeneration !== account.hostKeyGeneration ||
      current.accountUrl !== account.accountUrl ||
      current.userId !== account.userId ||
      current.organizationId !== account.organizationId
    )
      return 60000;
    const updated = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(snapshot),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    return updated.ok ? 5000 : 30000;
  }
  async function poll() {
    let delay = 30000;
    try {
      delay = await sync();
    } catch {
      /* Recover on the next poll; never log credentials or turn identifiers. */
    }
    if (!stopped) {
      timer = setTimeout(() => void poll(), delay);
      timer.unref();
    }
  }
  timer = setTimeout(() => void poll(), 1000);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    },
  };
}
