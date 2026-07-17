import { AuthSessionId, type AuthClientMetadata, type AuthClientSession } from "@synara/contracts";
import * as Crypto from "node:crypto";
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { AuthSessionRepositoryLive } from "../../persistence/Layers/AuthSessions";
import { AuthSessionRepository } from "../../persistence/Services/AuthSessions";
import { ServerConfig } from "../../config";
import { ServerSecretStore } from "../Services/ServerSecretStore";
import {
  SessionCapacityError,
  SessionCredentialError,
  SessionCredentialService,
  type IssuedSession,
  type SessionCredentialChange,
  type SessionCredentialServiceShape,
  type VerifiedSession,
} from "../Services/SessionCredentialService";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "../utils";

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);
export const MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION = 8;
export const MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION = 16;
const CAPACITY_RETRY_AFTER_SECONDS = 1;

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(2),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  jti: Schema.String,
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

function createDefaultClientMetadata(): AuthClientMetadata {
  return { deviceType: "unknown" };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return { ...input, current: false };
}

function toSessionCredentialError(message: string, cause?: unknown) {
  return new SessionCredentialError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

interface ActiveConnectionLease {
  readonly connectionId: string;
  readonly sessionId: AuthSessionId;
  readonly expiresAt: DateTime.DateTime;
}

type ActiveConnections = ReadonlyMap<AuthSessionId, ReadonlyMap<string, Effect.Effect<void>>>;

interface OutstandingWebSocketTicket {
  readonly sessionId: AuthSessionId;
  readonly expiresAtMillis: number;
}

type OutstandingWebSocketTickets = ReadonlyMap<string, OutstandingWebSocketTicket>;

export const makeSessionCredentialService = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const authSessions = yield* AuthSessionRepository;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const activeConnectionsRef = yield* Ref.make<ActiveConnections>(new Map());
  // Tickets are an in-memory allowlist, not merely signed bearer claims. A restart
  // intentionally invalidates every outstanding ticket, so an old signed value
  // cannot become replayable when the process-local consumption ledger is lost.
  const outstandingWebSocketTicketsRef = yield* Ref.make<OutstandingWebSocketTickets>(new Map());
  const activeConnectionsSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  const cookieName = resolveSessionCookieName({ mode: serverConfig.mode, port: serverConfig.port });

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, { type: "clientUpserted", clientSession }).pipe(Effect.asVoid);

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, { type: "clientRemoved", sessionId }).pipe(Effect.asVoid);

  const loadActiveSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      const row = yield* authSessions.getById({ sessionId });
      const now = yield* Clock.currentTimeMillis;
      if (
        Option.isNone(row) ||
        row.value.revokedAt !== null ||
        DateTime.toEpochMillis(row.value.expiresAt) <= now
      ) {
        return Option.none<AuthClientSession>();
      }
      const activeConnections = yield* Ref.get(activeConnectionsRef);
      return Option.some(
        toAuthClientSession({
          sessionId: row.value.sessionId,
          subject: row.value.subject,
          role: row.value.role,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          issuedAt: row.value.issuedAt,
          expiresAt: row.value.expiresAt,
          lastConnectedAt: row.value.lastConnectedAt,
          connected: activeConnections.has(row.value.sessionId),
        }),
      );
    });

  const acquireConnection = (sessionId: AuthSessionId, interrupt: Effect.Effect<void>) =>
    activeConnectionsSemaphore
      .withPermit(
        Effect.gen(function* () {
          const row = yield* authSessions.getById({ sessionId });
          const now = yield* DateTime.now;
          if (Option.isNone(row)) {
            return yield* toSessionCredentialError("Unknown authenticated session.");
          }
          if (row.value.revokedAt !== null) {
            return yield* toSessionCredentialError("Authenticated session revoked.");
          }
          if (DateTime.toEpochMillis(row.value.expiresAt) <= DateTime.toEpochMillis(now)) {
            return yield* toSessionCredentialError("Authenticated session expired.");
          }

          const connectionId = Crypto.randomUUID();
          const currentConnections = yield* Ref.get(activeConnectionsRef);
          const activeConnectionCount = currentConnections.get(sessionId)?.size ?? 0;
          if (activeConnectionCount >= MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION) {
            yield* Effect.logWarning("Rejected authenticated websocket connection capacity.").pipe(
              Effect.annotateLogs({
                scope: "connections",
                active: activeConnectionCount,
                limit: MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
              }),
            );
            return yield* new SessionCapacityError({
              message: "Authenticated websocket connection capacity exceeded.",
              scope: "connections",
              limit: MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
              active: activeConnectionCount,
              retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
            });
          }
          const wasDisconnected = !currentConnections.has(sessionId);
          if (wasDisconnected) {
            yield* authSessions.setLastConnectedAt({ sessionId, lastConnectedAt: now });
          }
          yield* Ref.update(activeConnectionsRef, (current) => {
            const next = new Map(current);
            const sessionConnections = new Map(next.get(sessionId) ?? []);
            sessionConnections.set(connectionId, interrupt);
            next.set(sessionId, sessionConnections);
            return next;
          });

          return {
            connectionId,
            sessionId,
            expiresAt: row.value.expiresAt,
          } satisfies ActiveConnectionLease;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionCredentialError || cause instanceof SessionCapacityError
            ? cause
            : toSessionCredentialError("Failed to register authenticated connection.", cause),
        ),
        Effect.tap(() =>
          loadActiveSession(sessionId).pipe(
            Effect.flatMap((session) =>
              Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to publish connected-session auth update", {
                sessionId,
                cause,
              }),
            ),
          ),
        ),
      );

  const releaseConnection = (lease: ActiveConnectionLease) =>
    activeConnectionsSemaphore
      .withPermit(
        Ref.modify(activeConnectionsRef, (current) => {
          const existing = current.get(lease.sessionId);
          if (!existing?.has(lease.connectionId)) return [false, current] as const;

          const next = new Map(current);
          const sessionConnections = new Map(existing);
          sessionConnections.delete(lease.connectionId);
          if (sessionConnections.size === 0) next.delete(lease.sessionId);
          else next.set(lease.sessionId, sessionConnections);
          return [sessionConnections.size === 0, next] as const;
        }),
      )
      .pipe(
        Effect.flatMap((wasLastConnection) =>
          wasLastConnection
            ? loadActiveSession(lease.sessionId).pipe(
                Effect.flatMap((session) =>
                  Option.isSome(session) ? emitUpsert(session.value) : emitRemoved(lease.sessionId),
                ),
              )
            : Effect.void,
        ),
        Effect.uninterruptible,
        Effect.catchCause((cause) =>
          Effect.logError("Failed to publish disconnected-session auth update", {
            sessionId: lease.sessionId,
            connectionId: lease.connectionId,
            cause,
          }),
        ),
      );

  const interruptConnections = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Effect.gen(function* () {
      const activeConnections = yield* Ref.get(activeConnectionsRef);
      const revokedConnections: Array<Effect.Effect<void>> = [];
      for (const sessionId of sessionIds) {
        const sessionConnections = activeConnections.get(sessionId);
        if (sessionConnections) revokedConnections.push(...sessionConnections.values());
      }
      yield* Effect.forEach(revokedConnections, (connection) => connection, {
        concurrency: "unbounded",
        discard: true,
      });
    });

  const pruneOutstandingWebSocketTickets = (
    current: OutstandingWebSocketTickets,
    nowMillis: number,
  ) => {
    const next = new Map(current);
    for (const [ticketId, ticket] of next) {
      if (ticket.expiresAtMillis <= nowMillis) next.delete(ticketId);
    }
    return next;
  };

  const clearOutstandingWebSocketTickets = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Ref.update(outstandingWebSocketTicketsRef, (current) => {
      const revokedSessionIds = new Set(sessionIds);
      const next = new Map(current);
      for (const [ticketId, ticket] of next) {
        if (revokedSessionIds.has(ticket.sessionId)) next.delete(ticketId);
      }
      return next;
    });

  const issue: SessionCredentialServiceShape["issue"] = (input) =>
    Effect.gen(function* () {
      const sessionId = AuthSessionId.makeUnsafe(Crypto.randomUUID());
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.addDuration(issuedAt, input?.ttl ?? DEFAULT_SESSION_TTL);
      const client = input?.client ?? createDefaultClientMetadata();
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        role: input?.role ?? "client",
        method: input?.method ?? "browser-session-cookie",
        iat: DateTime.toEpochMillis(issuedAt),
        exp: DateTime.toEpochMillis(expiresAt),
      };
      const encodedPayload = base64UrlEncode(JSON.stringify(claims));
      const signature = signPayload(encodedPayload, signingSecret);

      yield* authSessions.create({
        sessionId,
        subject: claims.sub,
        role: claims.role,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
        },
        issuedAt,
        expiresAt,
      });
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          subject: claims.sub,
          role: claims.role,
          method: claims.method,
          client,
          issuedAt,
          expiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return {
        sessionId,
        token: `${encodedPayload}.${signature}`,
        method: claims.method,
        client,
        expiresAt,
        role: claims.role,
      } satisfies IssuedSession;
    }).pipe(
      Effect.mapError((cause) =>
        toSessionCredentialError("Failed to issue session credential.", cause),
      ),
    );

  const verify: SessionCredentialServiceShape["verify"] = (token) =>
    Effect.gen(function* () {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature)
        return yield* toSessionCredentialError("Malformed session token.");
      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* toSessionCredentialError("Invalid session token signature.");
      }
      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) =>
          toSessionCredentialError("Invalid session token payload.", cause),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      if (claims.exp <= now) return yield* toSessionCredentialError("Session token expired.");
      const row = yield* authSessions.getById({ sessionId: claims.sid });
      if (Option.isNone(row)) return yield* toSessionCredentialError("Unknown session token.");
      if (DateTime.toEpochMillis(row.value.expiresAt) <= now) {
        return yield* toSessionCredentialError("Session token expired.");
      }
      if (row.value.revokedAt !== null)
        return yield* toSessionCredentialError("Session token revoked.");
      return {
        sessionId: claims.sid,
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: DateTime.makeUnsafe(claims.exp),
        subject: claims.sub,
        role: claims.role,
      } satisfies VerifiedSession;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionCredentialError
          ? cause
          : toSessionCredentialError("Failed to verify session credential.", cause),
      ),
    );

  const issueWebSocketToken: SessionCredentialServiceShape["issueWebSocketToken"] = (
    sessionId,
    input,
  ) =>
    activeConnectionsSemaphore
      .withPermit(
        Effect.gen(function* () {
          const row = yield* authSessions.getById({ sessionId });
          const issuedAt = yield* DateTime.now;
          const issuedAtMillis = DateTime.toEpochMillis(issuedAt);
          if (Option.isNone(row)) {
            return yield* toSessionCredentialError("Unknown websocket session.");
          }
          if (row.value.revokedAt !== null) {
            return yield* toSessionCredentialError("Websocket session revoked.");
          }
          const sessionExpiresAtMillis = DateTime.toEpochMillis(row.value.expiresAt);
          if (sessionExpiresAtMillis <= issuedAtMillis) {
            return yield* toSessionCredentialError("Websocket session expired.");
          }

          const requestedExpiresAt = DateTime.addDuration(
            issuedAt,
            input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL,
          );
          const expiresAtMillis = Math.min(
            DateTime.toEpochMillis(requestedExpiresAt),
            sessionExpiresAtMillis,
          );
          const expiresAt = DateTime.makeUnsafe(expiresAtMillis);
          const currentTickets = pruneOutstandingWebSocketTickets(
            yield* Ref.get(outstandingWebSocketTicketsRef),
            issuedAtMillis,
          );
          const activeTicketCount = Array.from(currentTickets.values()).filter(
            (ticket) => ticket.sessionId === sessionId,
          ).length;
          if (activeTicketCount >= MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION) {
            yield* Ref.set(outstandingWebSocketTicketsRef, currentTickets);
            yield* Effect.logWarning("Rejected websocket ticket capacity.").pipe(
              Effect.annotateLogs({
                scope: "websocket-tickets",
                active: activeTicketCount,
                limit: MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION,
              }),
            );
            return yield* new SessionCapacityError({
              message: "Outstanding websocket ticket capacity exceeded.",
              scope: "websocket-tickets",
              limit: MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION,
              active: activeTicketCount,
              retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
            });
          }

          const ticketId = Crypto.randomUUID();
          const claims: WebSocketClaims = {
            v: 2,
            kind: "websocket",
            sid: sessionId,
            jti: ticketId,
            iat: issuedAtMillis,
            exp: expiresAtMillis,
          };
          const encodedPayload = base64UrlEncode(JSON.stringify(claims));
          const signature = signPayload(encodedPayload, signingSecret);
          currentTickets.set(ticketId, { sessionId, expiresAtMillis });
          yield* Ref.set(outstandingWebSocketTicketsRef, currentTickets);
          return { token: `${encodedPayload}.${signature}`, expiresAt };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SessionCredentialError || cause instanceof SessionCapacityError
            ? cause
            : toSessionCredentialError("Failed to issue websocket token.", cause),
        ),
      );

  const verifyWebSocketToken: SessionCredentialServiceShape["verifyWebSocketToken"] = (token) =>
    Effect.gen(function* () {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature)
        return yield* toSessionCredentialError("Malformed websocket token.");
      const expectedSignature = signPayload(encodedPayload, signingSecret);
      if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
        return yield* toSessionCredentialError("Invalid websocket token signature.");
      }
      const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) =>
          toSessionCredentialError("Invalid websocket token payload.", cause),
        ),
      );
      return yield* activeConnectionsSemaphore.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const currentTickets = pruneOutstandingWebSocketTickets(
            yield* Ref.get(outstandingWebSocketTicketsRef),
            now,
          );
          const outstandingTicket = currentTickets.get(claims.jti);
          currentTickets.delete(claims.jti);
          yield* Ref.set(outstandingWebSocketTicketsRef, currentTickets);
          if (
            !outstandingTicket ||
            outstandingTicket.sessionId !== claims.sid ||
            outstandingTicket.expiresAtMillis !== claims.exp ||
            claims.exp <= now
          ) {
            return yield* toSessionCredentialError("Invalid websocket token.");
          }

          const row = yield* authSessions.getById({ sessionId: claims.sid });
          if (Option.isNone(row)) {
            return yield* toSessionCredentialError("Unknown websocket session.");
          }
          if (DateTime.toEpochMillis(row.value.expiresAt) <= now) {
            return yield* toSessionCredentialError("Websocket session expired.");
          }
          if (row.value.revokedAt !== null) {
            return yield* toSessionCredentialError("Websocket session revoked.");
          }
          return {
            sessionId: row.value.sessionId,
            token,
            method: row.value.method,
            client: toClientMetadata(row.value.client),
            expiresAt: row.value.expiresAt,
            subject: row.value.subject,
            role: row.value.role,
          } satisfies VerifiedSession;
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SessionCredentialError
          ? cause
          : toSessionCredentialError("Failed to verify websocket token.", cause),
      ),
    );

  const listActive: SessionCredentialServiceShape["listActive"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const activeConnections = yield* Ref.get(activeConnectionsRef);
      const rows = yield* authSessions.listActive({ now });
      return rows.map((row) =>
        toAuthClientSession({
          sessionId: row.sessionId,
          subject: row.subject,
          role: row.role,
          method: row.method,
          client: toClientMetadata(row.client),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          lastConnectedAt: row.lastConnectedAt,
          connected: activeConnections.has(row.sessionId),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        toSessionCredentialError("Failed to list active sessions.", cause),
      ),
    );

  const revoke: SessionCredentialServiceShape["revoke"] = (sessionId) =>
    activeConnectionsSemaphore
      .withPermit(
        Effect.gen(function* () {
          const revokedAt = yield* DateTime.now;
          const revoked = yield* authSessions.revoke({ sessionId, revokedAt });
          if (revoked) {
            yield* clearOutstandingWebSocketTickets([sessionId]);
            yield* interruptConnections([sessionId]);
            yield* emitRemoved(sessionId);
          }
          return revoked;
        }),
      )
      .pipe(
        Effect.mapError((cause) => toSessionCredentialError("Failed to revoke session.", cause)),
      );

  const revokeAllExcept: SessionCredentialServiceShape["revokeAllExcept"] = (sessionId) =>
    activeConnectionsSemaphore
      .withPermit(
        Effect.gen(function* () {
          const revokedAt = yield* DateTime.now;
          const revokedSessionIds = yield* authSessions.revokeAllExcept({
            currentSessionId: sessionId,
            revokedAt,
          });
          if (revokedSessionIds.length > 0) {
            yield* clearOutstandingWebSocketTickets(revokedSessionIds);
            yield* interruptConnections(revokedSessionIds);
            yield* Effect.forEach(revokedSessionIds, emitRemoved, {
              concurrency: "unbounded",
              discard: true,
            });
          }
          return revokedSessionIds.length;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          toSessionCredentialError("Failed to revoke other sessions.", cause),
        ),
      );

  const runAuthenticatedConnection: SessionCredentialServiceShape["runAuthenticatedConnection"] = (
    sessionId,
    effect,
  ) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const start = yield* Deferred.make<void>();
        const connectionFiber = yield* Effect.forkChild(
          Deferred.await(start).pipe(Effect.andThen(effect)),
          { startImmediately: true },
        );
        const lease = yield* acquireConnection(sessionId, Fiber.interrupt(connectionFiber)).pipe(
          Effect.onError(() => Fiber.interrupt(connectionFiber)),
        );
        yield* Deferred.succeed(start, undefined);
        return { lease, connectionFiber } as const;
      }),
      ({ lease, connectionFiber }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const expiresIn = Math.max(0, DateTime.toEpochMillis(lease.expiresAt) - now);
          const expiryFiber = yield* Effect.forkChild(
            Effect.sleep(Duration.millis(expiresIn)).pipe(
              Effect.andThen(Fiber.interrupt(connectionFiber)),
            ),
            { startImmediately: true },
          );
          return yield* Fiber.join(connectionFiber).pipe(
            Effect.ensuring(Fiber.interrupt(expiryFiber)),
          );
        }),
      ({ lease, connectionFiber }) =>
        Fiber.interrupt(connectionFiber).pipe(Effect.andThen(releaseConnection(lease))),
    );

  return {
    cookieName,
    issue,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    revokeAllExcept,
    runAuthenticatedConnection,
  } satisfies SessionCredentialServiceShape;
});

export const SessionCredentialServiceLive = Layer.effect(
  SessionCredentialService,
  makeSessionCredentialService,
).pipe(Layer.provideMerge(AuthSessionRepositoryLive));
