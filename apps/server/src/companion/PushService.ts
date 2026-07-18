import * as Crypto from "node:crypto";

import {
  ThreadId,
  type AuthSessionId,
  type CompanionNotificationKind,
  type CompanionNotificationPayload,
  type CompanionPushSubscription,
  type CompanionPushSubscriptionInput,
  type OrchestrationEvent,
} from "@synara/contracts";
import type {
  Scope,
} from "effect";
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Schedule,
  ServiceMap,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import webPush from "web-push";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { sanitizeCompanionPreview } from "./sanitize";

const ENVELOPE_SECRET_NAME = "companion-push-envelope-key";
const VAPID_SECRET_NAME = "companion-push-vapid-keypair";
const NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const DELIVERY_DIAGNOSTICS_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 16 * 60_000] as const;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const WEB_PUSH_HOSTS = new Set([
  "android.googleapis.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

interface SubscriptionRow {
  readonly id: string;
  readonly sessionId: AuthSessionId;
  readonly transport: "webpush";
  readonly encryptedSubscription: string;
  readonly previewEnabled: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DeliveryRow {
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly transport: "webpush";
  readonly encryptedSubscription: string;
  readonly attempts: number;
  readonly kind: CompanionNotificationKind;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly preview: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

type StoredSubscription = CompanionPushSubscriptionInput["subscription"];

export class CompanionPushError extends Error {
  readonly _tag = "CompanionPushError";
}

export interface CompanionPushServiceShape {
  readonly vapidPublicKey: string;
  readonly register: (input: {
    readonly sessionId: AuthSessionId;
    readonly value: CompanionPushSubscriptionInput;
  }) => Effect.Effect<CompanionPushSubscription, CompanionPushError>;
  readonly remove: (input: {
    readonly sessionId: AuthSessionId;
    readonly subscriptionId: string;
  }) => Effect.Effect<boolean, CompanionPushError>;
  readonly sendTest: (sessionId: AuthSessionId) => Effect.Effect<boolean, CompanionPushError>;
  readonly runPending: Effect.Effect<number, never>;
  readonly cleanup: Effect.Effect<void, never>;
  /** Runs even while remote access is paused so revocation cleanup is immediate. */
  readonly startRevocationCleanup: Effect.Effect<void, never, Scope.Scope>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class CompanionPushService extends ServiceMap.Service<
  CompanionPushService,
  CompanionPushServiceShape
>()("synara/companion/PushService") {}

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function encryptSubscription(value: StoredSubscription, key: Uint8Array): string {
  const iv = Crypto.randomBytes(12);
  const cipher = Crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [base64Url(iv), base64Url(cipher.getAuthTag()), base64Url(ciphertext)].join(".");
}

function decryptSubscription(value: string, key: Uint8Array): StoredSubscription {
  const [encodedIv, encodedTag, encodedCiphertext] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Malformed encrypted push subscription.");
  }
  const decipher = Crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as StoredSubscription;
}

function subscriptionIdentity(subscription: StoredSubscription): string {
  return subscription.endpoint;
}

function subscriptionHash(subscription: StoredSubscription): string {
  return Crypto.createHash("sha256").update(subscriptionIdentity(subscription), "utf8").digest("hex");
}

export function normalizeWebPushEndpoint(value: string): string | null {
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== "https:" ||
      !WEB_PUSH_HOSTS.has(endpoint.hostname.toLowerCase()) ||
      (endpoint.port !== "" && endpoint.port !== "443") ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.hash !== "" ||
      endpoint.pathname === "/"
    ) {
      return null;
    }
    return endpoint.toString();
  } catch {
    return null;
  }
}

function normalizeSubscription(subscription: StoredSubscription): StoredSubscription | null {
  const endpoint = normalizeWebPushEndpoint(subscription.endpoint);
  return endpoint ? { ...subscription, endpoint } : null;
}

/** Produces the only text that is permitted to leave Synara in a push payload. */
export function sanitizeNotificationPreview(value: unknown): string | undefined {
  return sanitizeCompanionPreview(value);
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function notificationKindFromEvent(
  event: OrchestrationEvent,
): CompanionNotificationKind | undefined {
  if (event.type !== "thread.activity-appended") return undefined;
  switch (event.payload.activity.kind) {
    case "approval.requested":
      return "approval_required";
    case "user-input.requested":
      return "user_input_required";
    case "turn.completed": {
      const state = payloadRecord(event.payload.activity.payload).state;
      // Interruptions and cancellations are expected user actions, not
      // completion/failure alerts. Unknown states must not become false
      // success notifications either.
      if (state === "completed") return "task_completed";
      if (state === "failed") return "task_failed";
      return undefined;
    }
    default:
      return undefined;
  }
}

function notificationTitle(kind: CompanionNotificationKind): string {
  switch (kind) {
    case "task_completed":
      return "Task completed";
    case "task_failed":
      return "Task failed";
    case "approval_required":
      return "Approval required";
    case "user_input_required":
      return "Synara needs your input";
  }
}

function safeFailurePreview(_event: OrchestrationEvent): string | undefined {
  // Provider failures can contain commands, stack traces, environment values,
  // and absolute paths. A generic title is the only safe lock-screen payload.
  return undefined;
}

function safeQuestionPreview(event: OrchestrationEvent): string | undefined {
  if (event.type !== "thread.activity-appended") return undefined;
  const payload = payloadRecord(event.payload.activity.payload);
  if (event.payload.activity.kind === "approval.requested") {
    // Tool arguments and command details are intentionally never copied into a notification.
    return sanitizeNotificationPreview(event.payload.activity.summary);
  }
  if (event.payload.activity.kind === "user-input.requested") {
    const first = Array.isArray(payload.questions) ? payload.questions[0] : undefined;
    const question = payloadRecord(first);
    return sanitizeNotificationPreview(question.question ?? question.header);
  }
  return undefined;
}

function toPublicSubscription(row: SubscriptionRow): CompanionPushSubscription {
  return {
    id: row.id,
    transport: row.transport,
    previewEnabled: row.previewEnabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function statusCodeOf(cause: unknown): number | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const candidate = cause as { statusCode?: unknown; status?: unknown };
  const statusCode = candidate.statusCode ?? candidate.status;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export const makeCompanionPushService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const secretStore = yield* ServerSecretStore;
  const sessions = yield* SessionCredentialService;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const envelopeKey = yield* secretStore.getOrCreateRandom(ENVELOPE_SECRET_NAME, 32);

  const storedVapid = yield* secretStore.get(VAPID_SECRET_NAME);
  const vapid = yield* Effect.try({
    try: (): VapidKeyPair => {
      if (storedVapid) {
        const parsed = JSON.parse(Buffer.from(storedVapid).toString("utf8")) as VapidKeyPair;
        if (parsed.publicKey && parsed.privateKey) return parsed;
      }
      return webPush.generateVAPIDKeys();
    },
    catch: (cause) => new CompanionPushError("Failed to initialize push credentials.", { cause }),
  });
  if (!storedVapid) {
    yield* secretStore.set(VAPID_SECRET_NAME, Buffer.from(JSON.stringify(vapid), "utf8"));
  }
  webPush.setVapidDetails("mailto:noreply@synara.local", vapid.publicKey, vapid.privateKey);

  const register: CompanionPushServiceShape["register"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const id = Crypto.randomUUID();
      const subscription = normalizeSubscription(input.value.subscription);
      if (!subscription) {
        return yield* Effect.fail(
          new CompanionPushError("Unsupported push subscription destination."),
        );
      }
      const endpointHash = subscriptionHash(subscription);
      const encryptedSubscription = encryptSubscription(subscription, envelopeKey);
      // One destination per transport and device session prevents an authenticated
      // but malicious client from turning a single domain event into unbounded
      // third-party push traffic. Rotating an endpoint atomically replaces the old one.
      const rows = yield* sql.withTransaction(
        sql`
          DELETE FROM push_subscriptions
          WHERE session_id = ${input.sessionId}
            AND transport = ${subscription.transport}
            AND endpoint_hash <> ${endpointHash}
        `.pipe(
          Effect.flatMap(() => sql<SubscriptionRow>`
            INSERT INTO push_subscriptions (
              id, session_id, transport, endpoint_hash, encrypted_subscription,
              preview_enabled, created_at, updated_at, disabled_at, failure_count
            ) VALUES (
              ${id}, ${input.sessionId}, ${subscription.transport}, ${endpointHash},
              ${encryptedSubscription}, ${input.value.previewEnabled ? 1 : 0},
              ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, NULL, 0
            )
            ON CONFLICT(session_id, transport, endpoint_hash) DO UPDATE SET
              encrypted_subscription = excluded.encrypted_subscription,
              preview_enabled = excluded.preview_enabled,
              updated_at = excluded.updated_at,
              disabled_at = NULL,
              failure_count = 0,
              last_failure_at = NULL
            RETURNING id AS "id", session_id AS "sessionId", transport AS "transport",
              encrypted_subscription AS "encryptedSubscription", preview_enabled AS "previewEnabled",
              created_at AS "createdAt", updated_at AS "updatedAt"
          `),
        ),
      );
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new CompanionPushError("Push subscription was not saved."));
      }
      return toPublicSubscription(row);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CompanionPushError
          ? cause
          : new CompanionPushError("Failed to save push subscription.", { cause }),
      ),
    );

  const remove: CompanionPushServiceShape["remove"] = (input) =>
    sql<{ readonly id: string }>`
      DELETE FROM push_subscriptions
      WHERE id = ${input.subscriptionId} AND session_id = ${input.sessionId}
      RETURNING id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError((cause) => new CompanionPushError("Failed to remove push subscription.", { cause })),
    );

  const enqueueForSubscriptions = (input: {
    readonly eventKey: string;
    readonly sessionId?: AuthSessionId;
    readonly kind: CompanionNotificationKind;
    readonly threadId: ThreadId;
    readonly title: string;
    readonly preview?: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = new Date(Date.parse(input.createdAt) + NOTIFICATION_TTL_MS).toISOString();
      if (Date.parse(expiresAt) <= DateTime.toEpochMillis(now)) return false;
      const subscriptions = yield* sql<SubscriptionRow>`
        SELECT p.id AS "id", p.session_id AS "sessionId", p.transport AS "transport",
          p.encrypted_subscription AS "encryptedSubscription", p.preview_enabled AS "previewEnabled",
          p.created_at AS "createdAt", p.updated_at AS "updatedAt"
        FROM push_subscriptions p
        INNER JOIN auth_sessions s ON s.session_id = p.session_id
        WHERE p.disabled_at IS NULL
          AND s.revoked_at IS NULL
          AND s.expires_at > ${DateTime.formatIso(now)}
          AND s.access_profile = 'companion'
          AND p.created_at <= ${input.createdAt}
          ${input.sessionId ? sql`AND p.session_id = ${input.sessionId}` : sql``}
      `;
      yield* sql.withTransaction(
        Effect.forEach(
          subscriptions,
          (subscription) => {
            const notificationId = Crypto.randomUUID();
            const dedupeKey = `${input.eventKey}:${subscription.id}:${input.kind}`;
            return sql`
              INSERT INTO push_notifications (
                id, dedupe_key, thread_id, kind, title, preview, deep_link, created_at, expires_at
              ) VALUES (
                ${notificationId}, ${dedupeKey}, ${input.threadId}, ${input.kind}, ${input.title},
                ${subscription.previewEnabled === 1 ? (input.preview ?? null) : null},
                ${`/mobile/threads/${encodeURIComponent(input.threadId)}`}, ${input.createdAt}, ${expiresAt}
              )
              ON CONFLICT(dedupe_key) DO NOTHING
            `.pipe(
              Effect.flatMap(() => sql`
                INSERT INTO push_deliveries (
                  notification_id, subscription_id, status, attempts, next_attempt_at, updated_at
                )
                SELECT ${notificationId}, ${subscription.id}, 'pending', 0, ${input.createdAt}, ${input.createdAt}
                WHERE EXISTS (SELECT 1 FROM push_notifications WHERE id = ${notificationId})
                ON CONFLICT(notification_id, subscription_id) DO NOTHING
              `),
            );
          },
          { discard: true, concurrency: 1 },
        ),
      );
      return subscriptions.length > 0;
    });

  const enqueueDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const kind = notificationKindFromEvent(event);
      if (!kind || event.type !== "thread.activity-appended") return;
      const threadId = event.payload.threadId;
      let preview =
        kind === "task_failed"
          ? safeFailurePreview(event)
          : kind === "approval_required" || kind === "user_input_required"
            ? safeQuestionPreview(event)
            : undefined;
      if (kind === "task_completed") {
        const thread = yield* projection.getThreadDetailById(threadId);
        if (thread._tag === "Some") {
          const assistant = [...thread.value.messages]
            .reverse()
            .find((message) => message.role === "assistant" && !message.streaming);
          preview = sanitizeNotificationPreview(assistant?.text);
        }
      }
      yield* enqueueForSubscriptions({
        eventKey: event.eventId,
        kind,
        threadId,
        title: notificationTitle(kind),
        ...(preview ? { preview } : {}),
        createdAt: event.occurredAt,
      });
    });

  const sendTest: CompanionPushServiceShape["sendTest"] = (sessionId) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        enqueueForSubscriptions({
          eventKey: `test:${Crypto.randomUUID()}`,
          sessionId,
          kind: "task_completed",
          threadId: ThreadId.makeUnsafe("companion-test"),
          title: "Synara notifications are working",
          preview: "This device can receive private Companion updates.",
          createdAt: DateTime.formatIso(now),
        }),
      ),
      Effect.mapError((cause) => new CompanionPushError("Failed to queue test notification.", { cause })),
    );

  const deliver = (row: DeliveryRow) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const activeSubscription = yield* sql<{ readonly id: string }>`
        SELECT p.id AS "id"
        FROM push_subscriptions p
        INNER JOIN auth_sessions s ON s.session_id = p.session_id
        WHERE p.id = ${row.subscriptionId}
          AND p.disabled_at IS NULL
          AND s.revoked_at IS NULL
          AND s.expires_at > ${DateTime.formatIso(now)}
          AND s.access_profile = 'companion'
        LIMIT 1
      `;
      if (!activeSubscription[0]) {
        // The foreign-key cascade also removes pending deliveries. Rechecking
        // immediately before I/O prevents restart recovery from sending to a
        // revoked or naturally expired device.
        yield* sql`DELETE FROM push_subscriptions WHERE id = ${row.subscriptionId}`;
        return;
      }
      if (Date.parse(row.expiresAt) <= DateTime.toEpochMillis(now)) {
        yield* sql`
          UPDATE push_deliveries SET status = 'expired', updated_at = ${DateTime.formatIso(now)}
          WHERE notification_id = ${row.notificationId} AND subscription_id = ${row.subscriptionId}
        `;
        return;
      }

      const stored = yield* Effect.try({
        try: () => decryptSubscription(row.encryptedSubscription, envelopeKey),
        catch: (cause) => new CompanionPushError("Encrypted subscription could not be decoded.", { cause }),
      });
      const payload: CompanionNotificationPayload = {
        kind: row.kind,
        threadId: row.threadId,
        title: row.title,
        ...(row.preview ? { preview: row.preview } : {}),
        createdAt: row.createdAt,
      };
      const attempted = yield* Effect.tryPromise({
        try: async () => {
          await webPush.sendNotification(
            { endpoint: stored.endpoint, keys: stored.keys },
            JSON.stringify(payload),
            {
              TTL: 24 * 60 * 60,
              urgency: "normal",
              timeout: PUSH_REQUEST_TIMEOUT_MS,
            },
          );
          return 200;
        },
        catch: (cause) => cause,
      }).pipe(Effect.result);

      if (attempted._tag === "Success") {
        yield* sql`
          UPDATE push_deliveries SET status = 'delivered', attempts = ${row.attempts + 1},
            delivered_at = ${DateTime.formatIso(now)}, updated_at = ${DateTime.formatIso(now)},
            last_error_code = NULL
          WHERE notification_id = ${row.notificationId} AND subscription_id = ${row.subscriptionId}
        `;
        return;
      }

      const code = statusCodeOf(attempted.failure);
      const attempts = row.attempts + 1;
      if (code === 404 || code === 410) {
        yield* sql.withTransaction(
          sql`
            UPDATE push_subscriptions SET disabled_at = ${DateTime.formatIso(now)},
              failure_count = failure_count + 1, last_failure_at = ${DateTime.formatIso(now)}
            WHERE id = ${row.subscriptionId}
          `.pipe(
            Effect.flatMap(() => sql`
              UPDATE push_deliveries SET status = 'invalid', attempts = ${attempts},
                last_error_code = ${String(code)}, updated_at = ${DateTime.formatIso(now)}
              WHERE notification_id = ${row.notificationId} AND subscription_id = ${row.subscriptionId}
            `),
          ),
        );
        return;
      }

      const exhausted = attempts >= 5;
      const retryAt = DateTime.makeUnsafe(
        DateTime.toEpochMillis(now) + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!,
      );
      yield* sql.withTransaction(
        sql`
          UPDATE push_subscriptions SET failure_count = failure_count + 1,
            last_failure_at = ${DateTime.formatIso(now)} WHERE id = ${row.subscriptionId}
        `.pipe(
          Effect.flatMap(() => sql`
            UPDATE push_deliveries SET status = ${exhausted ? "failed" : "pending"},
              attempts = ${attempts}, next_attempt_at = ${DateTime.formatIso(retryAt)},
              last_error_code = ${code ? String(code) : "transient"}, updated_at = ${DateTime.formatIso(now)}
            WHERE notification_id = ${row.notificationId} AND subscription_id = ${row.subscriptionId}
          `),
        ),
      );
    });

  const runPending: CompanionPushServiceShape["runPending"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const rows = yield* sql<DeliveryRow>`
      SELECT d.notification_id AS "notificationId", d.subscription_id AS "subscriptionId",
        d.attempts AS "attempts", p.transport AS "transport",
        p.encrypted_subscription AS "encryptedSubscription", n.kind AS "kind",
        n.thread_id AS "threadId", n.title AS "title", n.preview AS "preview",
        n.created_at AS "createdAt", n.expires_at AS "expiresAt"
      FROM push_deliveries d
      INNER JOIN push_subscriptions p ON p.id = d.subscription_id
      INNER JOIN push_notifications n ON n.id = d.notification_id
      INNER JOIN auth_sessions s ON s.session_id = p.session_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ${DateTime.formatIso(now)}
        AND p.disabled_at IS NULL
        AND s.revoked_at IS NULL
        AND s.expires_at > ${DateTime.formatIso(now)}
        AND s.access_profile = 'companion'
      ORDER BY d.next_attempt_at ASC
      LIMIT 50
    `;
    yield* Effect.forEach(rows, deliver, { discard: true, concurrency: 4 });
    return rows.length;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Companion push delivery pass failed", { cause }).pipe(Effect.as(0)),
    ),
  );

  const cleanupRevokedSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const uploads = yield* sql<{ readonly storagePath: string }>`
        UPDATE companion_attachment_uploads SET revoked_at = ${DateTime.formatIso(now)}
        WHERE session_id = ${sessionId} AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING storage_path AS "storagePath"
      `;
      yield* sql`DELETE FROM push_subscriptions WHERE session_id = ${sessionId}`;
      yield* Effect.forEach(
        uploads,
        (upload) => fileSystem.remove(upload.storagePath, { force: true }).pipe(Effect.ignore),
        { discard: true, concurrency: 4 },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Companion device cleanup failed", { sessionId, cause }),
      ),
    );

  const cleanupInactiveSessions = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const inactiveSessions = yield* sql<{ readonly sessionId: AuthSessionId }>`
      SELECT p.session_id AS "sessionId"
      FROM push_subscriptions p
      LEFT JOIN auth_sessions s ON s.session_id = p.session_id
      WHERE s.session_id IS NULL OR s.revoked_at IS NOT NULL
        OR s.expires_at <= ${DateTime.formatIso(now)} OR s.access_profile <> 'companion'
      UNION
      SELECT u.session_id AS "sessionId"
      FROM companion_attachment_uploads u
      LEFT JOIN auth_sessions s ON s.session_id = u.session_id
      WHERE u.consumed_at IS NULL AND u.revoked_at IS NULL
        AND (
          s.session_id IS NULL OR s.revoked_at IS NOT NULL
          OR s.expires_at <= ${DateTime.formatIso(now)}
        )
    `;
    yield* Effect.forEach(
      inactiveSessions,
      (row) => cleanupRevokedSession(row.sessionId),
      { discard: true, concurrency: 4 },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Companion inactive-session cleanup failed", { cause }),
    ),
  );

  const cleanup: CompanionPushServiceShape["cleanup"] = Effect.gen(function* () {
    yield* cleanupInactiveSessions;
    const now = yield* DateTime.now;
    const diagnosticsCutoff = new Date(
      DateTime.toEpochMillis(now) - DELIVERY_DIAGNOSTICS_TTL_MS,
    ).toISOString();
    yield* sql`
      UPDATE push_deliveries SET status = 'expired', updated_at = ${DateTime.formatIso(now)}
      WHERE status = 'pending' AND notification_id IN (
        SELECT id FROM push_notifications WHERE expires_at <= ${DateTime.formatIso(now)}
      )
    `;
    yield* sql`DELETE FROM push_notifications WHERE created_at < ${diagnosticsCutoff}`;
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Companion push cleanup failed", { cause })),
  );

  // The domain-event stream is hot. A process may stop after an orchestration
  // event commits but before the push outbox observes it, so recover the only
  // events that are still deliverable from durable storage on every startup.
  // The outbox dedupe key makes overlap with the live stream harmless.
  const replayRecentNotificationEvents = Stream.unwrap(
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const cutoff = new Date(DateTime.toEpochMillis(now) - NOTIFICATION_TTL_MS).toISOString();
      const rows = yield* sql<{ readonly firstSequence: number }>`
        SELECT COALESCE(
          MIN(sequence),
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM orchestration_events)
        ) AS "firstSequence"
        FROM orchestration_events
        WHERE event_type = 'thread.activity-appended'
          AND occurred_at >= ${cutoff}
      `;
      const firstSequence = Math.max(1, Number(rows[0]?.firstSequence ?? 1));
      return engine.readEvents(firstSequence - 1).pipe(
        Stream.filter(
          (event) =>
            Date.parse(event.occurredAt) >= Date.parse(cutoff) &&
            notificationKindFromEvent(event) !== undefined,
        ),
      );
    }),
  ).pipe(
    Stream.catchCause((cause) =>
      Stream.fromEffect(
        Effect.logWarning("Companion notification recovery replay failed", { cause }),
      ).pipe(Stream.flatMap(() => Stream.empty)),
    ),
  );

  const startRevocationCleanup: CompanionPushServiceShape["startRevocationCleanup"] =
    Effect.gen(function* () {
      // Subscribe first, then reconcile durable state. If a revoke races startup,
      // it is observed by either the stream or the subsequent database scan.
      yield* Effect.forkScoped(
        Stream.runForEach(sessions.streamChanges, (change) =>
          change.type === "clientRemoved" ? cleanupRevokedSession(change.sessionId) : Effect.void,
        ),
      );
      yield* cleanupInactiveSessions;
      yield* Effect.forkScoped(
        cleanupInactiveSessions.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1)))),
      );
    });

  const start: CompanionPushServiceShape["start"] = Effect.gen(function* () {
    yield* cleanup;
    yield* runPending;
    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.merge(engine.streamDomainEvents, replayRecentNotificationEvents),
        (event) =>
          enqueueDomainEvent(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Companion notification projection failed", {
                eventId: event.eventId,
                eventType: event.type,
                cause,
              }),
            ),
          ),
      ),
    );
    yield* Effect.forkScoped(
      runPending.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(15)))),
    );
    yield* Effect.forkScoped(
      cleanup.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1)))),
    );
  });

  return {
    vapidPublicKey: vapid.publicKey,
    register,
    remove,
    sendTest,
    runPending,
    cleanup,
    startRevocationCleanup,
    start,
  } satisfies CompanionPushServiceShape;
});

export const CompanionPushServiceLive = Layer.effect(
  CompanionPushService,
  makeCompanionPushService,
);
