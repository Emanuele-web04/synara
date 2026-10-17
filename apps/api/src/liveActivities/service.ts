import type pg from "pg";
import type {
  RegisterLiveActivity,
  RegisterTurnNotification,
  RemoveTurnNotifications,
  LiveActivityHostSnapshot,
  LiveActivitySource,
} from "@synara/contracts";
import { HostAuthDomainError, type HostRecord } from "../identity/interfaces";
import type { ActivityDelivery, NotificationDelivery, ApnsResult } from "./apns";

type Owner = { userId: string; orgId: string; sessionId: string };
type ActivityRow = {
  id: string;
  delivery_kind: "liveactivity" | "notification";
  notification_source: string | null;
  user_id: string;
  org_id: string;
  session_id: string;
  device_id: string;
  request: RegisterLiveActivity & { hostGenerations?: Record<string, number> };
  created_at: Date;
  expires_at: Date;
  ended: boolean;
  last_timestamp: string;
  last_payload: string | null;
  attempts: number;
};
const fail = (message: string) => {
  throw new HostAuthDomainError(403, "unauthorized", message);
};
const key = (source: { threadId: string; turnId: string }) =>
  JSON.stringify([source.threadId, source.turnId]);
const swiftEpoch = 978307200;

// ActivityKit decodes the existing Swift ContentState verbatim. Its
// display-state strings differ from the host protocol's state vocabulary.
function widgetConversation<
  T extends { state: LiveActivityHostSnapshot["turns"][number]["state"] },
>(item: T) {
  return {
    ...item,
    state: {
      running: "Running",
      needsApproval: "Approval needed",
      needsInput: "Reply needed",
      ready: "Ready",
      failed: "Failed",
      stopped: "Out of date",
    }[item.state],
  };
}

/** Durable, coalescing outbox: each activity owns the newest desired snapshot.
 * APNs is at-least-once. A row lock serializes sends, revision fences registration,
 * and a monotonic APNs timestamp keeps delayed/retried updates from winning.
 */
export function createLiveActivityService(options: {
  pool: pg.Pool;
  environment: "sandbox" | "production" | "both";
  send: (delivery: ActivityDelivery) => Promise<ApnsResult>;
  sendNotification?: (delivery: NotificationDelivery) => Promise<ApnsResult>;
  isMember: (userId: string, orgId: string) => Promise<boolean>;
}) {
  const { pool } = options;
  async function transaction<T>(run: (db: pg.PoolClient) => Promise<T>) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await run(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }

  async function registerDestination(
    owner: Owner,
    request: RegisterLiveActivity,
    kind: ActivityRow["delivery_kind"],
  ) {
    const notificationSource =
      kind === "notification"
        ? JSON.stringify([
            owner.orgId,
            request.sources[0]!.hostId,
            request.sources[0]!.threadId,
            request.sources[0]!.turnId,
          ])
        : null;
    if (options.environment !== "both" && request.environment !== options.environment)
      fail("Push environment is not configured");
    await transaction(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `live-activity:${owner.userId}`,
      ]);
      const device = await db.query<{ id: string }>(
        `SELECT d.id FROM devices d
        JOIN device_account_sessions s ON s.device_id = d.id
        WHERE d.user_id=$1 AND d.jkt=$2 AND d.revoked_at IS NULL
        AND s.user_id=$1 AND s.session_id=$3 AND s.revoked_at IS NULL`,
        [owner.userId, request.deviceJkt, owner.sessionId],
      );
      if (!device.rows[0]) fail("Register this device before enabling push updates");
      const hostIds = [...new Set(request.sources.map((source) => source.hostId))];
      const hosts = await db.query<{ id: string; key_generation: number }>(
        `SELECT id,key_generation FROM hosts WHERE id=ANY($1::uuid[])
        AND owner_user_id=$2 AND owner_org_id=$3 AND public_key_jwk IS NOT NULL`,
        [hostIds, owner.userId, owner.orgId],
      );
      if (hosts.rowCount !== hostIds.length) fail("Activity computers must belong to this account");
      const boundRequest = {
        ...request,
        hostGenerations: Object.fromEntries(
          hosts.rows.map((host) => [host.id, host.key_generation]),
        ),
      };
      // An ordinary device token legitimately owns several exact-turn watches.
      if (kind === "liveactivity") {
        const collision = await db.query(
          "SELECT id FROM live_activities WHERE delivery_kind='liveactivity' AND NOT ended AND request->>'token'=$1 AND id<>$2",
          [request.token, request.activityId],
        );
        if (collision.rowCount) fail("Push token is already registered");
      }
      const previous = (
        await db.query<ActivityRow>(
          "SELECT * FROM live_activities WHERE id=$1 OR (device_id=$2 AND notification_source=$3) FOR UPDATE",
          [request.activityId, device.rows[0]!.id, notificationSource],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.delivery_kind !== kind ||
          previous.notification_source !== notificationSource ||
          previous.user_id !== owner.userId ||
          previous.org_id !== owner.orgId ||
          previous.session_id !== owner.sessionId ||
          previous.device_id !== device.rows[0]!.id
        )
          fail("Activity belongs to another session");
        if (
          hosts.rows.some(
            (host) =>
              previous.request.hostGenerations?.[host.id] !== undefined &&
              previous.request.hostGenerations[host.id] !== host.key_generation,
          )
        )
          fail("Host identity changed");
        // A different UUID/reconnect cannot resend an already delivered exact turn.
        if (previous.ended || previous.expires_at.getTime() <= Date.now()) {
          if (kind === "notification") return;
          fail("Activity has ended");
        }
        if (request.revision <= previous.request.revision) return;
        await db.query(
          `UPDATE live_activities SET request=$2, dirty=true, attempts=0, next_attempt_at=now() WHERE id=$1`,
          [previous.id, JSON.stringify({ ...boundRequest, activityId: previous.id })],
        );
      } else {
        const count = (
          await db.query<{ count: string }>(
            "SELECT count(*) FROM live_activities WHERE user_id=$1 AND delivery_kind=$2 AND NOT ended AND expires_at>now()",
            [owner.userId, kind],
          )
        ).rows[0];
        if (Number(count?.count) >= (kind === "notification" ? 64 : 8))
          fail("Too many active push subscriptions");
        await db.query(
          `INSERT INTO live_activities (id,user_id,org_id,session_id,device_id,request,delivery_kind,notification_source,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+($9*interval '1 hour'))`,
          [
            request.activityId,
            owner.userId,
            owner.orgId,
            owner.sessionId,
            device.rows[0]!.id,
            JSON.stringify(boundRequest),
            kind,
            notificationSource,
            kind === "notification" ? 24 : 4,
          ],
        );
      }
    });
  }

  function register(owner: Owner, request: RegisterLiveActivity) {
    return registerDestination(owner, request, "liveactivity");
  }

  function registerNotification(owner: Owner, request: RegisterTurnNotification) {
    if (!options.sendNotification) fail("Completion push is not configured");
    return registerDestination(
      owner,
      {
        activityId: request.notificationId,
        deviceJkt: request.deviceJkt,
        revision: request.revision,
        token: request.token,
        environment: request.environment,
        sources: [request.source],
      },
      "notification",
    );
  }

  async function remove(
    owner: Owner,
    id: string,
    kind: ActivityRow["delivery_kind"] = "liveactivity",
  ) {
    // Keep a tombstone until expiry; a late registration cannot resurrect a dismissed activity.
    await pool.query(
      `UPDATE live_activities SET ended=true, request=jsonb_set(request,'{token}','""')
      WHERE id=$1 AND user_id=$2 AND org_id=$3 AND session_id=$4 AND delivery_kind=$5`,
      [id, owner.userId, owner.orgId, owner.sessionId, kind],
    );
  }

  // Logout/forget need one bounded revocation request, independent of how many
  // exact turns the phone watched before suspension.
  async function removeNotifications(owner: Owner, request: RemoveTurnNotifications) {
    await pool.query(
      `UPDATE live_activities a SET ended=true,request=jsonb_set(request,'{token}','""')
      WHERE a.delivery_kind='notification' AND a.user_id=$1 AND a.org_id=$2 AND a.session_id=$3
      AND a.device_id IN (SELECT d.id FROM devices d JOIN device_account_sessions s ON s.device_id=d.id
        WHERE d.user_id=$1 AND d.jkt=$4 AND s.user_id=$1 AND s.session_id=$3)
      AND ($5::text IS NULL OR a.request->'sources' @> $6::jsonb)`,
      [
        owner.userId,
        owner.orgId,
        owner.sessionId,
        request.deviceJkt,
        request.hostId ?? null,
        JSON.stringify(request.hostId ? [{ hostId: request.hostId }] : []),
      ],
    );
  }

  async function watches(
    host: HostRecord,
  ): Promise<readonly Pick<LiveActivitySource, "threadId" | "turnId">[]> {
    const rows = await pool.query<{ source: LiveActivitySource }>(
      `SELECT DISTINCT source FROM live_activities a,
      LATERAL jsonb_array_elements(a.request->'sources') source
      WHERE NOT a.ended AND a.expires_at>now() AND a.user_id=$1 AND a.org_id=$2 AND source->>'hostId'=$3 LIMIT 257`,
      [host.ownerUserId, host.ownerOrgId, host.id],
    );
    if (rows.rows.length > 256) fail("Too many watched turns");
    return rows.rows.map(({ source }) => ({ threadId: source.threadId, turnId: source.turnId }));
  }

  async function publish(host: HostRecord, snapshot: LiveActivityHostSnapshot) {
    await transaction(async (db) => {
      // Recheck the verified generation under this transaction's host lock; the
      // proof verifier uses a separate transaction, so never hold its lock here.
      const current = await db.query(
        `SELECT id FROM hosts WHERE id=$1 AND key_generation=$2
      AND owner_user_id=$3 AND owner_org_id=$4 AND public_key_jwk IS NOT NULL FOR UPDATE`,
        [host.id, host.keyGeneration, host.ownerUserId, host.ownerOrgId],
      );
      if (!current.rowCount) fail("Host identity changed");
      await db.query(
        `INSERT INTO live_activity_hosts(host_id,key_generation,snapshot)
      VALUES($1,$2,$3) ON CONFLICT(host_id) DO UPDATE SET key_generation=$2,snapshot=$3,updated_at=now()
      WHERE live_activity_hosts.key_generation<>$2 OR (live_activity_hosts.snapshot->>'sequence')::bigint <= $4`,
        [host.id, host.keyGeneration, JSON.stringify(snapshot), snapshot.sequence],
      );
      await db.query(
        `UPDATE live_activities SET dirty=true,next_attempt_at=CASE WHEN attempts=0 THEN now() ELSE next_attempt_at END WHERE NOT ended AND user_id=$1 AND org_id=$2
      AND request->'sources' @> $3::jsonb`,
        [host.ownerUserId, host.ownerOrgId, JSON.stringify([{ hostId: host.id }])],
      );
    });
  }

  async function deliver(id: string) {
    await transaction(async (db) => {
      const activity = (
        await db.query<ActivityRow>(
          `SELECT * FROM live_activities
        WHERE id=$1 AND NOT ended AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED`,
          [id],
        )
      ).rows[0];
      if (!activity) return;
      const stop = () =>
        db.query(
          `UPDATE live_activities SET ended=true,request=jsonb_set(request,'{token}','""') WHERE id=$1`,
          [id],
        );
      const authorized = await db.query(
        `SELECT d.id FROM devices d JOIN device_account_sessions s ON s.device_id=d.id
        WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND s.session_id=$3 AND s.user_id=$2 AND s.revoked_at IS NULL`,
        [activity.device_id, activity.user_id, activity.session_id],
      );
      if (!authorized.rowCount || !(await options.isMember(activity.user_id, activity.org_id))) {
        await stop();
        return;
      }
      const hostIds = [...new Set(activity.request.sources.map((source) => source.hostId))];
      const rows = await db.query<{
        id: string;
        key_generation: number;
        snapshot: LiveActivityHostSnapshot | null;
        updated_at: Date | null;
      }>(
        `SELECT h.id,h.key_generation,s.snapshot,s.updated_at
        FROM hosts h LEFT JOIN live_activity_hosts s ON s.host_id=h.id AND s.key_generation=h.key_generation
        WHERE h.id=ANY($1::uuid[]) AND h.owner_user_id=$2 AND h.owner_org_id=$3 AND h.public_key_jwk IS NOT NULL`,
        [hostIds, activity.user_id, activity.org_id],
      );
      if (
        rows.rowCount !== hostIds.length ||
        rows.rows.some(
          (host) => activity.request.hostGenerations?.[host.id] !== host.key_generation,
        )
      ) {
        await stop();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const expired = activity.expires_at.getTime() <= Date.now();
      if (activity.delivery_kind === "notification") {
        // Missing/offline reports are never invented completions. Keep the
        // one-shot watch durable while the phone is suspended, up to its TTL.
        const source = activity.request.sources[0]!;
        const host = rows.rows.find((row) => row.id === source.hostId)!;
        const fresh = host.updated_at && Date.now() - host.updated_at.getTime() < 90000;
        const turn = fresh
          ? host.snapshot?.turns.find((turn) => key(turn) === key(source))
          : undefined;
        if (expired || turn?.state === "stopped") {
          await stop();
          return;
        }
        if (!turn || (turn.state !== "ready" && turn.state !== "failed")) {
          await db.query(
            "UPDATE live_activities SET dirty=false,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
            [id],
          );
          return;
        }
        const result = await options.sendNotification?.({
          environment: activity.request.environment,
          token: activity.request.token,
          notificationId: id,
          threadId: source.displayId,
          turnId: source.turnId,
          result: turn.state === "ready" ? "completed" : "failed",
        });
        if (
          result === "delivered" ||
          result === "invalid-token" ||
          result === "rejected" ||
          activity.attempts >= 7
        ) {
          await stop();
        } else {
          const attempts = activity.attempts + 1;
          await db.query(
            "UPDATE live_activities SET attempts=$2,next_attempt_at=now()+($3*interval '1 second') WHERE id=$1",
            [id, attempts, Math.min(300, 2 ** attempts)],
          );
        }
        return;
      }
      const conversations = activity.request.sources.map((source) => {
        const host = rows.rows.find((row) => row.id === source.hostId)!;
        const fresh = host.updated_at && Date.now() - host.updated_at.getTime() < 90000;
        const turn = fresh
          ? host.snapshot?.turns.find((turn) => key(turn) === key(source))
          : undefined;
        const awaitingFirstReport = !turn && Date.now() - activity.created_at.getTime() < 90000;
        const state = expired
          ? "stopped"
          : (turn?.state ?? (awaitingFirstReport ? "running" : "stopped"));
        return {
          id: source.displayId,
          title: "Synara task",
          detail: "Synara",
          state,
          ...(turn ? { runningStartedAt: Math.max(0, turn.startedAt - swiftEpoch) } : {}),
        };
      });
      const running = conversations.filter((item) =>
        ["running", "needsApproval", "needsInput"].includes(item.state),
      );
      const content = {
        runningConversations: running.slice(0, 3).map(widgetConversation),
        completedConversations: conversations
          .filter((item) => item.state === "ready")
          .slice(0, Math.max(0, 3 - running.length))
          .map(widgetConversation),
        failedConversations: conversations
          .filter((item) => item.state === "failed")
          .slice(
            0,
            Math.max(
              0,
              3 - running.length - conversations.filter((item) => item.state === "ready").length,
            ),
          )
          .map(widgetConversation),
      };
      const fingerprint = JSON.stringify(content);
      if (
        running.length &&
        fingerprint === activity.last_payload &&
        now - Number(activity.last_timestamp) < 30
      ) {
        await db.query(
          "UPDATE live_activities SET dirty=false,next_attempt_at=now()+interval '5 seconds' WHERE id=$1",
          [id],
        );
        return;
      }
      const timestamp = Math.max(now, Number(activity.last_timestamp) + 1);
      const event = running.length ? "update" : "end";
      const result = await options.send({
        environment: activity.request.environment,
        token: activity.request.token,
        activityId: id,
        timestamp,
        event,
        contentState: { ...content, updatedAt: timestamp - swiftEpoch },
      });
      if (result === "invalid-token" || (result === "delivered" && event === "end")) {
        await stop();
        return;
      }
      if (result === "delivered") {
        await db.query(
          `UPDATE live_activities SET dirty=false,attempts=0,last_payload=$2,last_timestamp=$3,next_attempt_at=now()+interval '30 seconds' WHERE id=$1`,
          [id, fingerprint, timestamp],
        );
      } else {
        const attempts = activity.attempts + 1;
        if (attempts >= 8) {
          await stop();
          return;
        }
        await db.query(
          `UPDATE live_activities SET attempts=$2,last_timestamp=$3,next_attempt_at=now()+($4*interval '1 second') WHERE id=$1`,
          [id, attempts, timestamp, Math.min(300, 2 ** attempts)],
        );
      }
    });
  }

  let flushing: Promise<void> | undefined;
  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      const due = await pool.query<{ id: string }>(
        `SELECT id FROM live_activities WHERE NOT ended AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 32`,
      );
      for (const { id } of due.rows) {
        try {
          await deliver(id);
        } catch {
          // A failed membership lookup or transient database/send failure for one
          // account must not starve other recipients. Keep data out of logs.
          await pool.query(
            "UPDATE live_activities SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
            [id],
          );
        }
      }
      await pool.query("DELETE FROM live_activities WHERE expires_at<now()-interval '1 day'");
      await pool.query("DELETE FROM live_activity_hosts WHERE updated_at<now()-interval '1 day'");
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }
  return { register, registerNotification, remove, removeNotifications, watches, publish, flush };
}
export type LiveActivityService = ReturnType<typeof createLiveActivityService>;
