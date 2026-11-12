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
import { exponentialBackoffMs, jitterMs } from "./backoff";
import { accountLiveActivityEnabled } from "./remoteFeaturePolicy";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "./persistence/Services/ProviderRuntimeEvents";
import {
  attachCompletionPreviews,
  type CompletionPreviewTrust,
} from "./completionNotificationPreviews";

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

/** Watched turns are read and reported on this cadence. */
const WATCHED_POLL_MS = 5_000;
/** An unchanged snapshot is still sent this often; the account stops a run after 90 s without one. */
const HEARTBEAT_MS = 30_000;
/** Watch-list reads while a device is connected or recently was. */
const CONNECTED_POLL_MS = 15_000;
/** A device usually registers a watch while connected or just after it leaves. */
const DISCONNECTED_GRACE_MS = 10 * 60_000;
/**
 * The phone can also register a watch while disconnected (it retries a failed
 * registration every 15 s). This cadence still reports a new watch inside the
 * account's 90 s first-report window.
 */
const DISCONNECTED_POLL_MS = 60_000;
/** A refused host's reads double from one minute up to this. */
const FORBIDDEN_POLL_MAX_MS = 10 * 60_000;

/** Turn states and preview recipients, without the per-report sequence and ciphertext. */
function reportFingerprint(snapshot: LiveActivityHostSnapshot): string {
  return JSON.stringify({
    turns: snapshot.turns,
    previews: (snapshot.previews ?? []).map(({ preview: _ciphertext, ...binding }) => binding),
  });
}

/** ActivityKit and completion alerts share this exact-turn projection poll.
 * The durable sequence fences out-of-order reports; later polls repair uploads.
 * APNs credentials never reach this process. */
export function createAccountLiveActivityReporter(options: {
  baseDir: string;
  stateDir?: string;
  devUrl?: URL;
  hostIdentityPath: string;
  sql: SqlClient.SqlClient;
  completionPreviewTrust?: CompletionPreviewTrust;
  /** Whether a remote device is connected, and a subscription to one connecting. */
  remoteSessions?: {
    readonly open: () => boolean;
    readonly onOpened: (listener: () => void) => () => void;
  };
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let forbidden = 0;
  let polling = false;
  let wakeRequested = false;
  let pollStartedAt = Number.NEGATIVE_INFINITY;
  let lastConnectedAt = Number.NEGATIVE_INFINITY;
  let lastReport: { readonly fingerprint: string; readonly at: number } | undefined;
  const idleDelay = () =>
    options.remoteSessions === undefined ||
    performance.now() - lastConnectedAt < DISCONNECTED_GRACE_MS
      ? CONNECTED_POLL_MS
      : DISCONNECTED_POLL_MS;
  async function sync() {
    if (!accountLiveActivityEnabled(options.stateDir)) return 60000;
    const account = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
    if (!account?.hostId || account.hostKeyGeneration === undefined) return 60000;
    const identity = await readHostIdentity(options.hostIdentityPath);
    if (!identity) return 60000;
    const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
    // Only a device approved on this host can learn a turn to watch. Until the
    // first approval there is nothing to ask for; a local check each cycle
    // keeps the first watch inside the same 15 s pickup.
    const remoteAccessSetUp = options.completionPreviewTrust
      ? await Effect.runPromise(
          options.completionPreviewTrust.remoteTrust
            .hasIdentity(environmentId)
            .pipe(Effect.orElseSucceed(() => true)),
        )
      : true;
    if (!remoteAccessSetUp) return CONNECTED_POLL_MS;
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
    if (response.status === 403) {
      await response.body?.cancel();
      // Refused (owner left the workspace, or no subscription): no device can
      // register a watch until that changes, so wait longer each time. A device
      // connecting wakes the next read early.
      forbidden += 1;
      return exponentialBackoffMs(forbidden, 60_000, FORBIDDEN_POLL_MAX_MS);
    }
    forbidden = 0;
    if (!response.ok) {
      await response.body?.cancel();
      return 60000;
    }
    const body: unknown = await response.json();
    const WatchList = Schema.Struct({
      turns: Schema.Array(Schema.Struct({ threadId: Schema.String, turnId: Schema.String })).check(
        Schema.isMaxLength(256),
      ),
      previews: Schema.optional(Schema.Unknown),
    });
    if (!Schema.is(WatchList)(body) || body.turns.length === 0) {
      lastReport = undefined;
      return idleDelay();
    }
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
          const currentSnapshot = Schema.decodeUnknownSync(LiveActivityHostSnapshot)({
            sequence: projection?.sequence ?? 0,
            turns,
          });
          if (
            !options.completionPreviewTrust ||
            !account.hostId ||
            !account.hostOwnerUserId ||
            account.hostOwnerUserId !== account.userId ||
            !account.organizationId
          )
            return currentSnapshot;
          return yield* attachCompletionPreviews(
            sql,
            currentSnapshot,
            body.previews,
            {
              hostId: account.hostId,
              environmentId,
              accountAuthority: accountApiIssuer(account.accountUrl),
              userId: account.hostOwnerUserId,
              organizationId: account.organizationId,
            },
            options.completionPreviewTrust,
          );
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
      current.hostOwnerUserId !== account.hostOwnerUserId ||
      current.organizationId !== account.organizationId
    )
      return 60000;
    // Send only a changed report, plus a heartbeat well inside the account's staleness window.
    const fingerprint = reportFingerprint(snapshot);
    if (lastReport?.fingerprint === fingerprint && performance.now() - lastReport.at < HEARTBEAT_MS)
      return WATCHED_POLL_MS;
    const sentAt = performance.now();
    const updated = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(snapshot),
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    await updated.body?.cancel();
    if (!updated.ok) {
      lastReport = undefined;
      return 30000;
    }
    lastReport = { fingerprint, at: sentAt };
    return WATCHED_POLL_MS;
  }
  async function poll() {
    polling = true;
    pollStartedAt = performance.now();
    if (options.remoteSessions?.open()) lastConnectedAt = pollStartedAt;
    let delay = 30000;
    try {
      delay = await sync();
    } catch {
      /* Recover on the next poll; never log credentials or turn identifiers. */
    }
    polling = false;
    if (stopped) return;
    const next = wakeRequested ? Math.min(delay, WATCHED_POLL_MS) : jitterMs(delay);
    wakeRequested = false;
    timer = setTimeout(() => void poll(), next);
    timer.unref();
  }
  // A device that connects may be about to watch a turn, and a refused host may
  // be allowed again: read soon rather than at the end of a long wait, but never
  // closer than the watched cadence to the previous read.
  const stopWatchingSessions = options.remoteSessions?.onOpened(() => {
    lastConnectedAt = performance.now();
    if (stopped) return;
    if (polling) {
      wakeRequested = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(
      () => void poll(),
      Math.max(0, pollStartedAt + WATCHED_POLL_MS - performance.now()),
    );
    timer.unref();
  });
  timer = setTimeout(() => void poll(), 1000);
  timer.unref();
  return {
    stop() {
      stopped = true;
      stopWatchingSessions?.();
      clearTimeout(timer);
      controller.abort();
    },
  };
}
