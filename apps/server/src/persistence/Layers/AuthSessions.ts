import { AuthSessionId } from "@t3tools/contracts";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AuthSessionRepositoryError,
} from "../Errors";
import {
  AuthSessionRecord,
  AuthSessionRepository,
  type AuthSessionRepositoryShape,
  CreateAuthSessionInput,
  GetAuthSessionByIdInput,
  ListActiveAuthSessionsInput,
  RevokeAuthSessionInput,
  RevokeOtherAuthSessionsInput,
  SetAuthSessionLastConnectedAtInput,
} from "../Services/AuthSessions";

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): typeof AuthSessionRecord.Type {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    role: row.role,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function toIsoDateTime(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return DateTime.formatIso(value as DateTime.DateTime);
}

const makeAuthSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createSessionRow = SqlSchema.void({
    Request: CreateAuthSessionInput,
    execute: (input) => sql`
      INSERT INTO auth_sessions (
        session_id,
        subject,
        role,
        method,
        client_label,
        client_ip_address,
        client_user_agent,
        client_device_type,
        client_os,
        client_browser,
        issued_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${input.sessionId},
        ${input.subject},
        ${input.role},
        ${input.method},
        ${input.client.label},
        ${input.client.ipAddress},
        ${input.client.userAgent},
        ${input.client.deviceType},
        ${input.client.os},
        ${input.client.browser},
        ${toIsoDateTime(input.issuedAt)},
        ${toIsoDateTime(input.expiresAt)},
        NULL
      )
    `,
  });

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionDbRow,
    execute: ({ sessionId }) => sql`
      SELECT
        session_id AS "sessionId",
        subject AS "subject",
        role AS "role",
        method AS "method",
        client_label AS "clientLabel",
        client_ip_address AS "clientIpAddress",
        client_user_agent AS "clientUserAgent",
        client_device_type AS "clientDeviceType",
        client_os AS "clientOs",
        client_browser AS "clientBrowser",
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        last_connected_at AS "lastConnectedAt",
        revoked_at AS "revokedAt"
      FROM auth_sessions
      WHERE session_id = ${sessionId}
    `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionDbRow,
    execute: ({ now }) => sql`
      SELECT
        session_id AS "sessionId",
        subject AS "subject",
        role AS "role",
        method AS "method",
        client_label AS "clientLabel",
        client_ip_address AS "clientIpAddress",
        client_user_agent AS "clientUserAgent",
        client_device_type AS "clientDeviceType",
        client_os AS "clientOs",
        client_browser AS "clientBrowser",
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        last_connected_at AS "lastConnectedAt",
        revoked_at AS "revokedAt"
      FROM auth_sessions
      WHERE revoked_at IS NULL
        AND expires_at > ${toIsoDateTime(now)}
      ORDER BY issued_at DESC, session_id DESC
    `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) => sql`
      UPDATE auth_sessions
      SET last_connected_at = ${toIsoDateTime(lastConnectedAt)}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
    `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${toIsoDateTime(revokedAt)}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
      RETURNING session_id AS "sessionId"
    `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${toIsoDateTime(revokedAt)}
      WHERE session_id <> ${currentSessionId}
        AND revoked_at IS NULL
      RETURNING session_id AS "sessionId"
    `,
  });

  const create: AuthSessionRepositoryShape["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: AuthSessionRepositoryShape["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
        ),
      ),
      Effect.map((rowOption) => Option.map(rowOption, toAuthSessionRecord)),
    );

  const listActive: AuthSessionRepositoryShape["listActive"] = (input) =>
    listActiveSessionRows({ now: toIsoDateTime(input.now) }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toAuthSessionRecord)),
    );

  const revoke: AuthSessionRepositoryShape["revoke"] = (input) =>
    revokeSessionRows({
      sessionId: input.sessionId,
      revokedAt: toIsoDateTime(input.revokedAt),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepositoryShape["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows({
      currentSessionId: input.currentSessionId,
      revokedAt: toIsoDateTime(input.revokedAt),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepositoryShape["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
        ),
      ),
    );

  return { create, getById, listActive, revoke, revokeAllExcept, setLastConnectedAt };
});

export const AuthSessionRepositoryLive = Layer.effect(
  AuthSessionRepository,
  makeAuthSessionRepository,
);
