import * as Crypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EventId,
  ThreadId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Duration, Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import webPush from "web-push";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";

import {
  CompanionPushService,
  CompanionPushServiceLive,
  normalizeWebPushEndpoint,
  notificationKindFromEvent,
  sanitizeNotificationPreview,
} from "./PushService";

const threadId = ThreadId.makeUnsafe("push-thread");

afterEach(() => vi.restoreAllMocks());

function testWebPushSubscription(id: string) {
  const keys = webPush.generateVAPIDKeys();
  return {
    transport: "webpush" as const,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: {
      p256dh: keys.publicKey,
      auth: Crypto.randomBytes(16).toString("base64url"),
    },
  };
}

function activityEvent(
  state: string,
  input: { readonly eventId?: string; readonly occurredAt?: string } = {},
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: EventId.makeUnsafe(`activity-${input.eventId ?? state}`),
        tone: state === "failed" ? "error" : "info",
        kind: "turn.completed",
        summary: `Turn ${state}`,
        payload: { state },
        turnId: null,
        createdAt: occurredAt,
      },
    },
    sequence: 2,
    eventId: EventId.makeUnsafe(input.eventId ?? `event-${state}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
}

describe("sanitizeNotificationPreview", () => {
  it("collapses control characters and enforces the lock-screen limit", () => {
    const result = sanitizeNotificationPreview(`hello\n\u0000world ${"x".repeat(200)}`);
    expect(result).toHaveLength(160);
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\u0000");
  });

  it("redacts common credential shapes", () => {
    expect(sanitizeNotificationPreview("api_key=super-secret-value output ready")).toBe(
      "[redacted] output ready",
    );
    const tokenShapedFixture = ["ghp", "abcdefghijklmnopqrstuvwxyz1234"].join("_");
    expect(sanitizeNotificationPreview(`token ${tokenShapedFixture} done`)).toBe(
      "token [redacted] done",
    );
    expect(
      sanitizeNotificationPreview(
        "AWS AKIAIOSFODNN7EXAMPLE JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
      ),
    ).toBe("AWS [redacted] JWT [redacted]");
    expect(sanitizeNotificationPreview("failed at C:\\Users\\alice\\secret\\config.json")).toBe(
      "failed at [path]",
    );
    expect(sanitizeNotificationPreview("See https://example.com/mobile/help")).toBe(
      "See https://example.com/mobile/help",
    );
    expect(sanitizeNotificationPreview("summary ```console\nsecret output\n``` done")).toBe(
      "summary done",
    );
  });
});

describe("normalizeWebPushEndpoint", () => {
  it("accepts known browser push services and rejects arbitrary destinations", () => {
    expect(normalizeWebPushEndpoint("https://fcm.googleapis.com/fcm/send/device-id")).toBe(
      "https://fcm.googleapis.com/fcm/send/device-id",
    );
    expect(normalizeWebPushEndpoint("https://web.push.apple.com/Q-device-id")).toBe(
      "https://web.push.apple.com/Q-device-id",
    );
    expect(normalizeWebPushEndpoint("https://127.0.0.1/private")).toBeNull();
    expect(normalizeWebPushEndpoint("https://fcm.googleapis.com.evil.example/send/id")).toBeNull();
    expect(normalizeWebPushEndpoint("http://fcm.googleapis.com/fcm/send/id")).toBeNull();
    expect(normalizeWebPushEndpoint("https://fcm.googleapis.com:8443/fcm/send/id")).toBeNull();
    expect(normalizeWebPushEndpoint("https://user:pass@fcm.googleapis.com/fcm/send/id")).toBeNull();
  });
});

describe("notificationKindFromEvent", () => {
  it("only classifies successful and failed terminal turns", () => {
    expect(notificationKindFromEvent(activityEvent("completed"))).toBe("task_completed");
    expect(notificationKindFromEvent(activityEvent("failed"))).toBe("task_failed");
    expect(notificationKindFromEvent(activityEvent("interrupted"))).toBeUndefined();
    expect(notificationKindFromEvent(activityEvent("cancelled"))).toBeUndefined();
    expect(notificationKindFromEvent(activityEvent("unknown"))).toBeUndefined();
  });
});

describe("CompanionPushService recovery", () => {
  it("replays the durable delivery window and deduplicates overlap with live events", async () => {
    vi.spyOn(webPush, "sendNotification").mockResolvedValue({} as never);
    const now = new Date();
    // Keep this after subscription registration even on a slow migration pass.
    const recentAt = new Date(now.getTime() + 60_000).toISOString();
    const recentEvent = activityEvent("completed", {
      eventId: "event-recovery-completed",
      occurredAt: recentAt,
    });
    const readCursors: number[] = [];
    const secrets = new Map<string, Uint8Array>();

    const secretStore: ServerSecretStoreShape = {
      get: (name) => Effect.succeed(secrets.get(name) ?? null),
      set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = secrets.get(name);
          if (existing) return existing;
          const value = Crypto.randomBytes(bytes);
          secrets.set(name, value);
          return value;
        }),
      remove: (name) => Effect.sync(() => void secrets.delete(name)),
    };
    const sessions = {
      streamChanges: Stream.empty,
    } as unknown as SessionCredentialServiceShape;
    const engine = {
      readEvents: (cursor: number) => {
        readCursors.push(cursor);
        return Stream.make(recentEvent);
      },
      streamDomainEvents: Stream.make(recentEvent),
    } as unknown as OrchestrationEngineShape;
    const projection = {
      getThreadDetailById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQueryShape;

    const dependencies = Layer.mergeAll(
      SqlitePersistenceMemory,
      NodeServices.layer,
      Layer.succeed(ServerSecretStore, secretStore),
      Layer.succeed(SessionCredentialService, sessions),
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(ProjectionSnapshotQuery, projection),
    );
    const testLayer = CompanionPushServiceLive.pipe(Layer.provideMerge(dependencies));

    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const push = yield* CompanionPushService;
      const sessionId = AuthSessionId.makeUnsafe("push-recovery-session");
      const issuedAt = new Date(now.getTime() - 60_000).toISOString();
      const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();

      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, method, client_device_type, issued_at,
          expires_at, revoked_at, access_profile
        ) VALUES (
          ${sessionId}, 'push-test', 'client', 'browser-session-cookie', 'mobile',
          ${issuedAt}, ${expiresAt}, NULL, 'companion'
        )
      `;
      yield* push.register({
        sessionId,
        value: {
          subscription: testWebPushSubscription("test-recovery"),
          previewEnabled: true,
        },
      });

      const revokedSessionId = AuthSessionId.makeUnsafe("push-revoked-session");
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, method, client_device_type, issued_at,
          expires_at, revoked_at, access_profile
        ) VALUES (
          ${revokedSessionId}, 'push-revoked-test', 'client', 'browser-session-cookie', 'mobile',
          ${issuedAt}, ${expiresAt}, NULL, 'companion'
        )
      `;
      yield* push.register({
        sessionId: revokedSessionId,
        value: {
          subscription: testWebPushSubscription("test-revoked"),
          previewEnabled: true,
        },
      });
      yield* push.sendTest(revokedSessionId);
      yield* sql`
        UPDATE auth_sessions SET revoked_at = ${new Date().toISOString()}
        WHERE session_id = ${revokedSessionId}
      `;

      // Sequence 1 is outside the notification TTL. Sequence 2 is recent, so
      // recovery should begin at cursor 1 rather than replaying all history.
      const oldAt = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES
          (1, 'event-old', 'thread', ${threadId}, 1, 'thread.activity-appended',
            ${oldAt}, NULL, NULL, NULL, 'system', '{}', '{}'),
          (2, ${recentEvent.eventId}, 'thread', ${threadId}, 2, 'thread.activity-appended',
            ${recentAt}, NULL, NULL, NULL, 'system', '{}', '{}')
      `;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* push.startRevocationCleanup;
          yield* push.start;
          yield* Effect.sleep(Duration.millis(100));
          const notifications = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM push_notifications
            WHERE dedupe_key LIKE ${`${recentEvent.eventId}:%`}
          `;
          const subscriptions = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count" FROM push_subscriptions
          `;
          const revokedDeliveries = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM push_deliveries d
            INNER JOIN push_subscriptions p ON p.id = d.subscription_id
            WHERE p.session_id = ${revokedSessionId}
          `;
          expect({
            notifications: notifications[0]?.count,
            subscriptions: subscriptions[0]?.count,
            revokedDeliveries: revokedDeliveries[0]?.count,
            readCursors,
          }).toEqual({
            notifications: 1,
            subscriptions: 1,
            revokedDeliveries: 0,
            readCursors: [1],
          });
        }),
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
  });
});
