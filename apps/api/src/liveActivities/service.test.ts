import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { runMigrations } from "../db/migrate";
import { createLiveActivityService } from "./service";
import type { ActivityDelivery, NotificationDelivery, ApnsResult } from "./apns";
import type { RegisterLiveActivity, RegisterTurnNotification } from "@synara/contracts";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Live Activity durable delivery", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  beforeAll(async () => {
    await runMigrations(databaseUrl!);
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM live_activities");
  });
  afterAll(async () => {
    await pool.end();
  });
  async function fixture(
    environment: "sandbox" | "production" = "sandbox",
    deployment: "sandbox" | "both" = "sandbox",
  ) {
    const owner = { userId: randomUUID(), orgId: randomUUID(), sessionId: randomUUID() };
    const deviceId = randomUUID();
    const jkt = randomUUID();
    const hosts = [0, 1].map(() => ({
      id: randomUUID(),
      environmentId: randomUUID(),
      ownerUserId: owner.userId,
      ownerOrgId: owner.orgId,
      keyGeneration: 1,
      publicKeyJwk: null,
      discoverable: true,
    }));
    await pool.query(
      `INSERT INTO devices(id,user_id,public_key_jwk,jkt,display_name,platform) VALUES($1,$2,'{}',$3,'Test','ios')`,
      [deviceId, owner.userId, jkt],
    );
    await pool.query(
      "INSERT INTO device_account_sessions(device_id,user_id,session_id) VALUES($1,$2,$3)",
      [deviceId, owner.userId, owner.sessionId],
    );
    for (const host of hosts)
      await pool.query(
        `INSERT INTO hosts(id,owner_user_id,owner_org_id,environment_id,name,platform,kind,public_key_jwk,key_generation)
      VALUES($1,$2,$3,$4,'Test','darwin','local','{}',1)`,
        [host.id, owner.userId, owner.orgId, host.environmentId],
      );
    const request: RegisterLiveActivity = {
      activityId: randomUUID(),
      deviceJkt: jkt,
      revision: 1,
      token: (environment === "production" ? "c" : "a").repeat(64),
      environment,
      sources: hosts.map((host) => ({
        hostId: host.id,
        threadId: randomUUID(),
        turnId: randomUUID(),
        displayId: randomUUID(),
      })),
    };
    const sent: ActivityDelivery[] = [];
    const notifications: NotificationDelivery[] = [];
    let result: ApnsResult = "delivered";
    let member = true;
    const service = () =>
      createLiveActivityService({
        pool,
        environment: deployment,
        isMember: async () => member,
        sendNotification: async (delivery) => {
          notifications.push(delivery);
          return result;
        },
        send: async (delivery) => {
          sent.push(delivery);
          return result;
        },
      });
    const live = service();
    const publish = async (
      index: number,
      sequence: number,
      state: "running" | "ready" | "failed" | "stopped",
    ) => {
      const source = request.sources[index]!;
      await live.publish(hosts[index]!, {
        sequence,
        turns: [{ threadId: source.threadId, turnId: source.turnId, state, startedAt: 1790000000 }],
      });
    };
    const due = () =>
      pool.query("UPDATE live_activities SET next_attempt_at=now() WHERE id=$1", [
        request.activityId,
      ]);
    return {
      owner,
      deviceId,
      hosts,
      request,
      sent,
      notifications,
      notification: {
        notificationId: request.activityId,
        deviceJkt: request.deviceJkt,
        revision: request.revision,
        token: request.token,
        environment: request.environment,
        source: request.sources[0]!,
      } satisfies RegisterTurnNotification,
      live,
      service,
      publish,
      due,
      setResult: (value: ApnsResult) => {
        result = value;
      },
      revokeMembership: () => {
        member = false;
      },
    };
  }
  async function ageActivitySources(id: string, seconds: number) {
    const changedAt = Date.now() - seconds * 1000;
    const request = (await pool.query("SELECT request FROM live_activities WHERE id=$1", [id]))
      .rows[0].request as RegisterLiveActivity;
    const timestamps = Object.fromEntries(
      request.sources.map(({ hostId, threadId, turnId }) => [
        JSON.stringify([hostId, threadId, turnId]),
        changedAt,
      ]),
    );
    await pool.query(
      `UPDATE live_activities SET created_at=to_timestamp($2::double precision/1000),
      request=jsonb_set(request,'{sourcesRegisteredAt}',$3::jsonb) WHERE id=$1`,
      [id, changedAt, JSON.stringify(timestamps)],
    );
    return changedAt;
  }
  it("preserves each APNs environment through durable registration and restart", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const f = await fixture(environment, "both");
      await f.live.register(f.owner, f.request);
      await f.publish(0, 1, "running");
      await f.service().flush();
      expect(f.sent.at(-1)).toMatchObject({ environment, event: "update" });
    }
  });
  it("aggregates two computers, rejects old snapshots, and ends only after both turns finish across restart", async () => {
    const f = await fixture();
    await f.live.register(f.owner, f.request);
    await f.publish(0, 10, "ready");
    await f.publish(1, 10, "running");
    await f.live.flush();
    expect(f.sent.at(-1)?.event).toBe("update");
    expect(f.sent.at(-1)?.contentState).toMatchObject({
      runningConversations: [
        { id: f.request.sources[1]!.displayId, state: "Running", runningStartedAt: 811692800 },
      ],
      completedConversations: [{ id: f.request.sources[0]!.displayId, state: "Ready" }],
    });
    expect(JSON.stringify(f.sent)).not.toContain("threadId");
    await f.publish(1, 9, "ready");
    await f.live.flush();
    expect(f.sent).toHaveLength(1);
    await f.publish(1, 11, "failed");
    await f.due();
    await f.service().flush();
    expect(f.sent.at(-1)?.event).toBe("end");
    expect(f.sent.at(-1)?.timestamp).toBeGreaterThan(f.sent[0]!.timestamp);
    await expect(f.live.register(f.owner, { ...f.request, revision: 2 })).rejects.toThrow("ended");
  });
  it("fences token rotation, refuses foreign sessions/hosts, and tombstones removal", async () => {
    const f = await fixture();
    await expect(
      f.live.register({ ...f.owner, sessionId: randomUUID() }, f.request),
    ).rejects.toThrow();
    await expect(
      f.live.register(f.owner, { ...f.request, environment: "production" }),
    ).rejects.toThrow();
    const other = await fixture();
    await expect(
      f.live.register(f.owner, { ...f.request, sources: other.request.sources }),
    ).rejects.toThrow();
    await f.live.register(f.owner, f.request);
    await f.live.register(f.owner, { ...f.request, revision: 3, token: "b".repeat(64) });
    await f.live.register(f.owner, { ...f.request, revision: 2 });
    await f.publish(0, 1, "running");
    await f.publish(1, 1, "running");
    await f.live.flush();
    expect(f.sent.at(-1)?.token).toBe("b".repeat(64));
    await f.live.remove(f.owner, f.request.activityId);
    await expect(f.live.register(f.owner, { ...f.request, revision: 4 })).rejects.toThrow();
  });
  it("waits for the new exact turn after sources change on an older activity", async () => {
    const f = await fixture();
    const request = { ...f.request, sources: [f.request.sources[0]!] };
    await f.live.register(f.owner, request);
    await f.publish(0, 1, "running");
    await ageActivitySources(request.activityId, 120);
    const source = { ...request.sources[0]!, turnId: randomUUID() };
    const registeredAt = Date.now();
    // Even a caller that supplies this extra field cannot choose the server's clock.
    const identity = JSON.stringify([source.hostId, source.threadId, source.turnId]);
    const next = {
      ...request,
      revision: 2,
      sources: [source],
      sourcesRegisteredAt: { [identity]: 1 },
    };
    await f.live.register(f.owner, next);
    const stored = (
      await pool.query("SELECT request FROM live_activities WHERE id=$1", [request.activityId])
    ).rows[0];
    expect(stored.request.sourcesRegisteredAt[identity]).toBeGreaterThanOrEqual(registeredAt);
    expect(stored.request.sourcesRegisteredAt[identity]).toBeLessThanOrEqual(Date.now());
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({
      event: "update",
      contentState: {
        runningConversations: [{ id: source.displayId, state: "Running" }],
        completedConversations: [],
      },
    });
  });
  it("ends a changed source only after its own first-report grace expires", async () => {
    const f = await fixture();
    const request = { ...f.request, sources: [f.request.sources[0]!] };
    await f.live.register(f.owner, request);
    await f.publish(0, 1, "running");
    await ageActivitySources(request.activityId, 120);
    await f.live.register(f.owner, {
      ...request,
      revision: 2,
      sources: [{ ...request.sources[0]!, turnId: randomUUID() }],
    });
    await ageActivitySources(request.activityId, 91);
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({
      event: "end",
      contentState: { runningConversations: [], completedConversations: [] },
    });
  });
  it("does not renew first-report grace for token rotation, reordered sources or display aliases", async () => {
    const f = await fixture();
    await f.live.register(f.owner, f.request);
    const changedAt = await ageActivitySources(f.request.activityId, 91);
    await f.live.register(f.owner, {
      ...f.request,
      revision: 2,
      token: "b".repeat(64),
      sources: [...f.request.sources]
        .reverse()
        .map((source) => ({ ...source, displayId: randomUUID() })),
    });
    const stored = (
      await pool.query("SELECT request FROM live_activities WHERE id=$1", [f.request.activityId])
    ).rows[0];
    expect(Object.values(stored.request.sourcesRegisteredAt)).toEqual([changedAt, changedAt]);
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({ token: "b".repeat(64), event: "end" });
  });
  it("does not revive an expired missing source when another computer changes turns", async () => {
    const f = await fixture();
    await f.live.register(f.owner, f.request);
    await ageActivitySources(f.request.activityId, 120);
    // Both snapshots are fresh, but neither contains the next watched turn.
    await f.live.publish(f.hosts[0]!, { sequence: 1, turns: [] });
    await f.publish(1, 1, "running");
    const changedSource = { ...f.request.sources[1]!, turnId: randomUUID() };
    await f.live.register(f.owner, {
      ...f.request,
      revision: 2,
      sources: [f.request.sources[0]!, changedSource],
    });
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({
      event: "update",
      contentState: {
        runningConversations: [{ id: changedSource.displayId, state: "Running" }],
        completedConversations: [],
      },
    });
  });
  it("does not settle a newly watched turn from a late completion of the previous turn", async () => {
    const f = await fixture();
    const request = { ...f.request, sources: [f.request.sources[0]!] };
    await f.live.register(f.owner, request);
    await f.publish(0, 1, "running");
    await ageActivitySources(request.activityId, 120);
    const source = { ...request.sources[0]!, turnId: randomUUID() };
    await f.live.register(f.owner, { ...request, revision: 2, sources: [source] });
    await f.publish(0, 2, "ready");
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({
      event: "update",
      contentState: {
        runningConversations: [{ id: source.displayId, state: "Running" }],
        completedConversations: [],
      },
    });
    await f.live.publish(f.hosts[0]!, {
      sequence: 3,
      turns: [
        { threadId: source.threadId, turnId: source.turnId, state: "ready", startedAt: 1790000100 },
      ],
    });
    await f.live.flush();
    expect(f.sent.at(-1)).toMatchObject({
      event: "end",
      contentState: {
        runningConversations: [],
        completedConversations: [{ id: source.displayId, state: "Ready" }],
      },
    });
  });
  it.each(
    ["device", "session", "host", "generation", "membership"].flatMap((kind) =>
      ["liveactivity", "notification"].map((destination) => ({ kind, destination })),
    ),
  )("checks $kind revocation before $destination delivery", async ({ kind, destination }) => {
    const f = await fixture();
    if (destination === "notification") await f.live.registerNotification(f.owner, f.notification);
    else await f.live.register(f.owner, f.request);
    await f.publish(0, 1, "ready");
    if (kind === "device")
      await pool.query("UPDATE devices SET revoked_at=now() WHERE id=$1", [f.deviceId]);
    if (kind === "session")
      await pool.query("UPDATE device_account_sessions SET revoked_at=now() WHERE device_id=$1", [
        f.deviceId,
      ]);
    if (kind === "host")
      await pool.query("UPDATE hosts SET public_key_jwk=NULL,key_generation=2 WHERE id=$1", [
        f.hosts[0]!.id,
      ]);
    if (kind === "generation")
      await pool.query("UPDATE hosts SET key_generation=2 WHERE id=$1", [f.hosts[0]!.id]);
    if (kind === "membership") f.revokeMembership();
    await f.live.flush();
    expect(f.sent).toHaveLength(0);
    expect(f.notifications).toHaveLength(0);
  });
  it.each(["ready", "failed"] as const)(
    "delivers %s exact-turn alerts once across restart without ActivityKit payloads",
    async (state) => {
      const f = await fixture("production", "both");
      await f.live.registerNotification(f.owner, f.notification);
      expect(await f.live.watches(f.hosts[0]!)).toEqual([
        { threadId: f.notification.source.threadId, turnId: f.notification.source.turnId },
      ]);
      await f.publish(0, 1, "running");
      await f.live.flush();
      expect(f.notifications).toHaveLength(0);
      // A report about another exact turn never completes this watch.
      await f.live.publish(f.hosts[0]!, {
        sequence: 2,
        turns: [
          {
            threadId: f.notification.source.threadId,
            turnId: randomUUID(),
            state,
            startedAt: 1790000000,
          },
        ],
      });
      await f.due();
      await f.live.flush();
      expect(f.notifications).toHaveLength(0);
      await f.publish(0, 3, state);
      await f.service().flush();
      expect(f.notifications).toEqual([
        {
          environment: "production",
          token: f.notification.token,
          notificationId: f.notification.notificationId,
          threadId: f.notification.source.displayId,
          turnId: f.notification.source.turnId,
          result: state === "ready" ? "completed" : "failed",
        },
      ]);
      expect(f.sent).toHaveLength(0);
      const row = (
        await pool.query(
          "SELECT ended,request->>'token' AS token FROM live_activities WHERE id=$1",
          [f.notification.notificationId],
        )
      ).rows[0];
      expect(row).toEqual({ ended: true, token: "" });
      // Both the same ID and a fresh UUID are deduplicated by the exact source.
      await f.live.registerNotification(f.owner, { ...f.notification, revision: 2 });
      await f.live.registerNotification(f.owner, {
        ...f.notification,
        notificationId: randomUUID(),
        revision: 3,
      });
      await f.due();
      await f.service().flush();
      expect(f.notifications).toHaveLength(1);
    },
  );

  it.each(["stopped", "expired", "offline"])(
    "does not invent a completion alert for %s work",
    async (reason) => {
      const f = await fixture();
      await f.live.registerNotification(f.owner, f.notification);
      await f.publish(0, 1, reason === "stopped" ? "stopped" : "ready");
      if (reason === "expired")
        await pool.query(
          "UPDATE live_activities SET expires_at=now()-interval '1 second' WHERE id=$1",
          [f.notification.notificationId],
        );
      if (reason === "offline")
        await pool.query(
          "UPDATE live_activity_hosts SET updated_at=now()-interval '2 minutes' WHERE host_id=$1",
          [f.hosts[0]!.id],
        );
      await f.live.flush();
      expect(f.notifications).toHaveLength(0);
      if (reason === "offline") {
        // An offline host can recover later without losing the durable watch.
        await f.publish(0, 2, "ready");
        await f.live.flush();
        expect(f.notifications).toHaveLength(1);
      }
    },
  );

  it("keeps independent turns on one ordinary token, fences rotation/revisions and retires invalid tokens", async () => {
    const f = await fixture();
    await f.live.registerNotification(f.owner, f.notification);
    const second = {
      ...f.notification,
      notificationId: randomUUID(),
      source: f.request.sources[1]!,
    };
    await f.live.registerNotification(f.owner, second);
    await f.live.registerNotification(f.owner, {
      ...f.notification,
      token: "b".repeat(64),
      revision: 3,
    });
    await f.live.registerNotification(f.owner, { ...f.notification, revision: 2 });
    await f.publish(0, 1, "ready");
    f.setResult("retry");
    await f.live.flush();
    expect(f.notifications.at(-1)?.token).toBe("b".repeat(64));
    await f.due();
    f.setResult("invalid-token");
    await f.service().flush();
    const count = f.notifications.length;
    await f.due();
    await f.live.flush();
    expect(f.notifications).toHaveLength(count);
    expect(await f.live.watches(f.hosts[1]!)).toEqual([
      { threadId: second.source.threadId, turnId: second.source.turnId },
    ]);
    await expect(
      f.live.registerNotification({ ...f.owner, sessionId: randomUUID() }, second),
    ).rejects.toThrow();
    const other = await fixture();
    await expect(
      f.live.registerNotification(f.owner, { ...second, source: other.notification.source }),
    ).rejects.toThrow();
    await f.live.remove(f.owner, second.notificationId, "notification");
    await f.publish(1, 1, "ready");
    await f.service().flush();
    expect(f.notifications).toHaveLength(count);
  });

  it("revokes one device's retained watches in one request without crossing host, account or delivery kind", async () => {
    const f = await fixture();
    await f.live.registerNotification(f.owner, f.notification);
    const second = {
      ...f.notification,
      notificationId: randomUUID(),
      source: f.request.sources[1]!,
    };
    await f.live.registerNotification(f.owner, second);
    await f.live.register(f.owner, { ...f.request, activityId: randomUUID() });
    await f.live.removeNotifications(
      { ...f.owner, sessionId: randomUUID() },
      { deviceJkt: f.request.deviceJkt },
    );
    await f.live.removeNotifications(f.owner, { deviceJkt: "unknown-device" });
    expect(
      (await pool.query("SELECT count(*) FROM live_activities WHERE ended")).rows[0].count,
    ).toBe("0");
    await f.live.removeNotifications(f.owner, {
      deviceJkt: f.request.deviceJkt,
      hostId: f.hosts[0]!.id,
    });
    await f.publish(0, 1, "ready");
    await f.publish(1, 1, "running");
    await f.live.flush();
    expect(f.notifications).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
    await f.live.removeNotifications(f.owner, { deviceJkt: f.request.deviceJkt });
    await f.publish(1, 2, "ready");
    await f.live.flush();
    expect(f.notifications).toHaveLength(0);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM live_activities WHERE delivery_kind='notification' AND ended AND request->>'token'='' ",
        )
      ).rows[0].count,
    ).toBe("2");
  });

  it.each(["stale-host", "expired"])(
    "ends %s activities without inventing completion",
    async (reason) => {
      const f = await fixture();
      await f.live.register(f.owner, f.request);
      await f.publish(0, 1, "running");
      await f.publish(1, 1, "running");
      if (reason === "expired") {
        await pool.query(
          "UPDATE live_activities SET expires_at=now()-interval '1 second' WHERE id=$1",
          [f.request.activityId],
        );
      } else {
        await ageActivitySources(f.request.activityId, 120);
        await pool.query(
          "UPDATE live_activity_hosts SET updated_at=now()-interval '2 minutes' WHERE host_id=ANY($1::uuid[])",
          [f.hosts.map((host) => host.id)],
        );
      }
      await f.live.flush();
      expect(f.sent.at(-1)).toMatchObject({
        event: "end",
        contentState: { runningConversations: [], completedConversations: [] },
      });
      await expect(f.live.register(f.owner, { ...f.request, revision: 2 })).rejects.toThrow(
        "ended",
      );
    },
  );
  it("persists retries without replaying an obsolete update, and retires an invalid token", async () => {
    const f = await fixture();
    await f.live.register(f.owner, f.request);
    await f.publish(0, 1, "running");
    await f.publish(1, 1, "running");
    f.setResult("retry");
    await f.live.flush();
    await f.publish(0, 2, "stopped");
    await f.publish(1, 2, "ready");
    await f.due();
    f.setResult("invalid-token");
    await f.service().flush();
    expect(f.sent.at(-1)?.event).toBe("end");
    const count = f.sent.length;
    await f.due();
    await f.live.flush();
    expect(f.sent).toHaveLength(count);
  });
});
