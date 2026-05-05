import type { AuthClientSession, AuthPairingLink } from "@t3tools/contracts";
import { DateTime, Effect, Layer } from "effect";

import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import { SessionCredentialService } from "../Services/SessionCredentialService";
import {
  AuthControlPlane,
  AuthControlPlaneError,
  DEFAULT_SESSION_SUBJECT,
  type AuthControlPlaneShape,
  type IssuedBearerSession,
  type IssuedPairingLink,
} from "../Services/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import { SessionCredentialServiceLive } from "./SessionCredentialService";

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
  if (left.connected !== right.connected) return left.connected ? -1 : 1;
  return DateTime.toEpochMillis(right.issuedAt) - DateTime.toEpochMillis(left.issuedAt);
};

const toAuthControlPlaneError =
  (message: string) =>
  (cause: unknown): AuthControlPlaneError =>
    new AuthControlPlaneError({ message, cause });

export const makeAuthControlPlane = Effect.gen(function* () {
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const sessions = yield* SessionCredentialService;

  const createPairingLink: AuthControlPlaneShape["createPairingLink"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* DateTime.now;
      const role = input?.role ?? "client";
      const subject = input?.subject ?? "one-time-token";
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        role,
        subject,
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
      });
      return {
        id: issued.id,
        credential: issued.credential,
        role,
        subject,
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies IssuedPairingLink;
    }).pipe(Effect.mapError(toAuthControlPlaneError("Failed to create pairing link.")));

  const listPairingLinks: AuthControlPlaneShape["listPairingLinks"] = (input) =>
    bootstrapCredentials.listActive().pipe(
      Effect.map((pairingLinks) =>
        pairingLinks
          .filter((pairingLink) => (input?.role ? pairingLink.role === input.role : true))
          .filter((pairingLink) => !input?.excludeSubjects?.includes(pairingLink.subject))
          .map((pairingLink) =>
            pairingLink.label
              ? ({ ...pairingLink, label: pairingLink.label } satisfies AuthPairingLink)
              : ({
                  id: pairingLink.id,
                  credential: pairingLink.credential,
                  role: pairingLink.role,
                  subject: pairingLink.subject,
                  createdAt: pairingLink.createdAt,
                  expiresAt: pairingLink.expiresAt,
                } satisfies AuthPairingLink),
          )
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
          ),
      ),
      Effect.mapError(toAuthControlPlaneError("Failed to list pairing links.")),
    );

  const revokePairingLink: AuthControlPlaneShape["revokePairingLink"] = (id) =>
    bootstrapCredentials
      .revoke(id)
      .pipe(Effect.mapError(toAuthControlPlaneError("Failed to revoke pairing link.")));

  const issueSession: AuthControlPlaneShape["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        method: "bearer-session-token",
        role: input?.role ?? "owner",
        client: {
          ...(input?.label ? { label: input.label } : {}),
          deviceType: "bot",
        },
        ...(input?.ttl ? { ttl: input.ttl } : {}),
      })
      .pipe(
        Effect.flatMap((issued) =>
          issued.method === "bearer-session-token"
            ? Effect.succeed({
                sessionId: issued.sessionId,
                token: issued.token,
                method: "bearer-session-token" as const,
                role: issued.role,
                subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
                client: issued.client,
                expiresAt: DateTime.toUtc(issued.expiresAt),
              } satisfies IssuedBearerSession)
            : Effect.fail(
                new AuthControlPlaneError({
                  message: "Session issuance produced an unexpected method.",
                }),
              ),
        ),
        Effect.mapError(toAuthControlPlaneError("Failed to issue session token.")),
      );

  const listSessions: AuthControlPlaneShape["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => [...activeSessions].sort(bySessionPriority)),
      Effect.mapError(toAuthControlPlaneError("Failed to list sessions.")),
    );

  const revokeSession: AuthControlPlaneShape["revokeSession"] = (sessionId) =>
    sessions
      .revoke(sessionId)
      .pipe(Effect.mapError(toAuthControlPlaneError("Failed to revoke session.")));

  const revokeOtherSessionsExcept: AuthControlPlaneShape["revokeOtherSessionsExcept"] = (
    sessionId,
  ) =>
    sessions
      .revokeAllExcept(sessionId)
      .pipe(Effect.mapError(toAuthControlPlaneError("Failed to revoke other sessions.")));

  return {
    createPairingLink,
    listPairingLinks,
    revokePairingLink,
    issueSession,
    listSessions,
    revokeSession,
    revokeOtherSessionsExcept,
  } satisfies AuthControlPlaneShape;
});

export const AuthControlPlaneLive = Layer.effect(AuthControlPlane, makeAuthControlPlane);

export const AuthCoreLive = Layer.mergeAll(
  BootstrapCredentialServiceLive,
  SessionCredentialServiceLive.pipe(Layer.provide(ServerSecretStoreLive)),
);
