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

/** Reads only explicitly watched turns. The durable projection sequence fences
 * out-of-order snapshots; the next poll repairs interrupted uploads/restarts.
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
            const [turn] = yield* sql<{
              state: string;
              startedAt: string;
              approval: number;
              input: number;
            }>`
          SELECT t.state, COALESCE(t.started_at,t.requested_at) AS startedAt,
          EXISTS(SELECT 1 FROM projection_pending_interactions a WHERE a.thread_id=t.thread_id
            AND a.turn_id=t.turn_id AND a.status='pending' AND a.interaction_kind='approval') AS approval,
          EXISTS(SELECT 1 FROM projection_pending_interactions a WHERE a.thread_id=t.thread_id
            AND a.turn_id=t.turn_id AND a.status='pending' AND a.interaction_kind='userInput') AS input
          FROM projection_turns t WHERE t.thread_id=${watch.threadId} AND t.turn_id=${watch.turnId}`;
            if (!turn) continue;
            const state =
              turn.state === "running"
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
            const startedAt = Date.parse(turn.startedAt) / 1000;
            if (Number.isFinite(startedAt)) turns.push({ ...watch, state, startedAt });
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
