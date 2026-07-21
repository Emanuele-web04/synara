import type { ExternalMcpCapability, ExternalMcpClientKind } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { recordCreatedWorktreeInPlan } from "../../agentGateway/operationPlan.ts";
import {
  ExternalMcpRepository,
  type ExternalMcpIntegrationRecord,
  type ExternalMcpOperationRecord,
  type ExternalMcpRepositoryShape,
  type ExternalMcpTaskRecord,
  type ReserveExternalMcpOperationResult,
} from "../Services/ExternalMcpRepository.ts";

interface IntegrationRow {
  readonly integrationId: string;
  readonly name: string;
  readonly clientKind: ExternalMcpClientKind;
  readonly audience: "synara.external-mcp";
  readonly credentialHash: string | null;
  readonly capabilitiesJson: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly pairedAt: string | null;
  readonly revokedAt: string | null;
  readonly rateLimitPerMinute: number;
  readonly concurrencyLimit: number;
}

interface OperationRow extends ExternalMcpOperationRecord {}

const repositoryError = (operation: string) => (cause: unknown) =>
  new Error(`External MCP repository failed during ${operation}.`, { cause });

function parseCapabilities(value: string): ReadonlyArray<ExternalMcpCapability> {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as ReadonlyArray<ExternalMcpCapability>) : [];
}

export const makeExternalMcpRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readProjectIds = (integrationId: string) =>
    sql<{ readonly projectId: string }>`
      SELECT project_id AS "projectId"
      FROM external_mcp_integration_projects
      WHERE integration_id = ${integrationId}
      ORDER BY project_id ASC
    `;

  const hydrateIntegration = (row: IntegrationRow) =>
    readProjectIds(row.integrationId).pipe(
      Effect.map(
        (projects): ExternalMcpIntegrationRecord => ({
          integrationId: row.integrationId,
          name: row.name,
          clientKind: row.clientKind,
          audience: row.audience,
          credentialHash: row.credentialHash,
          capabilities: parseCapabilities(row.capabilitiesJson),
          projectIds: projects.map((project) => project.projectId),
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt,
          pairedAt: row.pairedAt,
          revokedAt: row.revokedAt,
          rateLimitPerMinute: row.rateLimitPerMinute,
          concurrencyLimit: row.concurrencyLimit,
        }),
      ),
    );

  const selectIntegration = (where: ReturnType<typeof sql.literal>) => sql<IntegrationRow>`
    SELECT
      integration_id AS "integrationId",
      name,
      client_kind AS "clientKind",
      audience,
      credential_hash AS "credentialHash",
      capabilities_json AS "capabilitiesJson",
      created_at AS "createdAt",
      expires_at AS "expiresAt",
      last_used_at AS "lastUsedAt",
      paired_at AS "pairedAt",
      revoked_at AS "revokedAt",
      rate_limit_per_minute AS "rateLimitPerMinute",
      concurrency_limit AS "concurrencyLimit"
    FROM external_mcp_integrations
    WHERE ${where}
  `;

  const createIntegration: ExternalMcpRepositoryShape["createIntegration"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO external_mcp_integrations (
              integration_id, name, client_kind, audience, credential_hash, capabilities_json,
              created_at, expires_at, last_used_at, paired_at, revoked_at,
              rate_limit_per_minute, concurrency_limit
            ) VALUES (
              ${input.integrationId}, ${input.name}, ${input.clientKind ?? "other"}, ${input.audience}, NULL,
              ${JSON.stringify(input.capabilities)}, ${input.createdAt}, ${input.expiresAt},
              NULL, NULL, NULL, ${input.rateLimitPerMinute}, ${input.concurrencyLimit}
            )
          `;
          yield* Effect.forEach(
            input.projectIds,
            (projectId) => sql`
              INSERT INTO external_mcp_integration_projects (integration_id, project_id)
              VALUES (${input.integrationId}, ${projectId})
            `,
            { discard: true },
          );
          yield* sql`
            INSERT INTO external_mcp_pairing_codes (
              pairing_hash, integration_id, created_at, expires_at, consumed_at
            ) VALUES (
              ${input.pairingHash}, ${input.integrationId}, ${input.createdAt},
              ${input.pairingExpiresAt}, NULL
            )
          `;
        }),
      )
      .pipe(Effect.mapError(repositoryError("createIntegration")));

  const listIntegrations: ExternalMcpRepositoryShape["listIntegrations"] = () =>
    sql<IntegrationRow>`
      SELECT
        integration_id AS "integrationId", name, client_kind AS "clientKind", audience,
        credential_hash AS "credentialHash", capabilities_json AS "capabilitiesJson",
        created_at AS "createdAt", expires_at AS "expiresAt",
        last_used_at AS "lastUsedAt", paired_at AS "pairedAt", revoked_at AS "revokedAt",
        rate_limit_per_minute AS "rateLimitPerMinute",
        concurrency_limit AS "concurrencyLimit"
      FROM external_mcp_integrations
      ORDER BY created_at DESC, integration_id DESC
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, hydrateIntegration)),
      Effect.mapError(repositoryError("listIntegrations")),
    );

  const getIntegrationById: ExternalMcpRepositoryShape["getIntegrationById"] = (integrationId) =>
    selectIntegration(sql`integration_id = ${integrationId}`).pipe(
      Effect.flatMap((rows) => (rows[0] ? hydrateIntegration(rows[0]) : Effect.succeed(null))),
      Effect.mapError(repositoryError("getIntegrationById")),
    );

  const getActiveIntegrationByCredentialHash: ExternalMcpRepositoryShape["getActiveIntegrationByCredentialHash"] =
    (input) =>
      selectIntegration(
        sql`credential_hash = ${input.credentialHash} AND revoked_at IS NULL AND expires_at > ${input.now}`,
      ).pipe(
        Effect.flatMap((rows) => (rows[0] ? hydrateIntegration(rows[0]) : Effect.succeed(null))),
        Effect.mapError(repositoryError("getActiveIntegrationByCredentialHash")),
      );

  const consumePairingCode: ExternalMcpRepositoryShape["consumePairingCode"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const pairing = yield* sql<{
            readonly integrationId: string;
            readonly consumedAt: string | null;
            readonly expiresAt: string;
            readonly credentialHash: string | null;
          }>`
            SELECT pairing.integration_id AS "integrationId",
              pairing.consumed_at AS "consumedAt", pairing.expires_at AS "expiresAt",
              integrations.credential_hash AS "credentialHash"
            FROM external_mcp_pairing_codes AS pairing
            JOIN external_mcp_integrations AS integrations
              ON integrations.integration_id = pairing.integration_id
            WHERE pairing.pairing_hash = ${input.pairingHash}
              AND integrations.revoked_at IS NULL
              AND integrations.expires_at > ${input.now}
            LIMIT 1
          `;
          const match = pairing[0];
          const integrationId = match?.integrationId;
          if (!integrationId) return null;
          if (match.consumedAt !== null) {
            if (match.credentialHash !== input.credentialHash) return null;
            const rows = yield* selectIntegration(sql`integration_id = ${integrationId}`);
            return rows[0] ? yield* hydrateIntegration(rows[0]) : null;
          }
          if (match.expiresAt <= input.now) return null;
          const consumed = yield* sql<{ readonly integrationId: string }>`
            UPDATE external_mcp_pairing_codes
            SET consumed_at = ${input.now}
            WHERE pairing_hash = ${input.pairingHash}
              AND consumed_at IS NULL
            RETURNING integration_id AS "integrationId"
          `;
          if (consumed.length === 0) return null;
          const assigned = yield* sql<{ readonly integrationId: string }>`
            UPDATE external_mcp_integrations
            SET credential_hash = ${input.credentialHash}, paired_at = ${input.now}
            WHERE integration_id = ${integrationId}
              AND credential_hash IS NULL
              AND revoked_at IS NULL
              AND expires_at > ${input.now}
            RETURNING integration_id AS "integrationId"
          `;
          if (assigned.length === 0) return null;
          const rows = yield* selectIntegration(sql`integration_id = ${integrationId}`);
          return rows[0] ? yield* hydrateIntegration(rows[0]) : null;
        }),
      )
      .pipe(Effect.mapError(repositoryError("consumePairingCode")));

  const refreshPairingCode: ExternalMcpRepositoryShape["refreshPairingCode"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const active = yield* sql<{ readonly integrationId: string }>`
            SELECT integration_id AS "integrationId"
            FROM external_mcp_integrations
            WHERE integration_id = ${input.integrationId}
              AND credential_hash IS NULL
              AND paired_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > ${input.createdAt}
            LIMIT 1
          `;
          if (active.length === 0) return false;
          yield* sql`
            DELETE FROM external_mcp_pairing_codes
            WHERE integration_id = ${input.integrationId}
          `;
          yield* sql`
            INSERT INTO external_mcp_pairing_codes (
              pairing_hash, integration_id, created_at, expires_at, consumed_at
            ) VALUES (
              ${input.pairingHash}, ${input.integrationId}, ${input.createdAt}, ${input.expiresAt}, NULL
            )
          `;
          return true;
        }),
      )
      .pipe(Effect.mapError(repositoryError("refreshPairingCode")));

  const revokeIntegration: ExternalMcpRepositoryShape["revokeIntegration"] = (input) =>
    sql<{ readonly integrationId: string }>`
      UPDATE external_mcp_integrations
      SET revoked_at = ${input.revokedAt}, credential_hash = NULL
      WHERE integration_id = ${input.integrationId} AND revoked_at IS NULL
      RETURNING integration_id AS "integrationId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(repositoryError("revokeIntegration")),
    );

  const touchLastUsed: ExternalMcpRepositoryShape["touchLastUsed"] = (input) =>
    sql`
      UPDATE external_mcp_integrations
      SET last_used_at = ${input.usedAt}
      WHERE integration_id = ${input.integrationId} AND revoked_at IS NULL
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("touchLastUsed")));

  const beginAudit: ExternalMcpRepositoryShape["beginAudit"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const active = yield* sql<{ readonly integrationId: string }>`
            SELECT integration_id AS "integrationId"
            FROM external_mcp_integrations
            WHERE integration_id = ${input.integrationId}
              AND revoked_at IS NULL
              AND expires_at > ${input.now}
            LIMIT 1
          `;
          if (active.length === 0) return false;
          yield* sql`
            DELETE FROM external_mcp_audit_log
            WHERE integration_id = ${input.integrationId}
              AND created_at < ${input.retentionCutoff}
          `;
          const windows = yield* sql<{
            readonly windowId: number;
            readonly admittedCount: number;
            readonly rejectedCount: number;
          }>`
            SELECT window_id AS "windowId", admitted_count AS "admittedCount",
              rejected_count AS "rejectedCount"
            FROM external_mcp_rate_windows
            WHERE integration_id = ${input.integrationId}
            LIMIT 1
          `;
          const window = windows[0];
          const admittedCount = window?.windowId === input.windowId ? window.admittedCount : 0;
          const rejectedCount = window?.windowId === input.windowId ? window.rejectedCount : 0;
          const admitted = admittedCount < input.rateLimitPerMinute;
          yield* sql`
            INSERT INTO external_mcp_rate_windows (
              integration_id, window_id, admitted_count, rejected_count,
              rejection_audit_id, updated_at
            ) VALUES (
              ${input.integrationId}, ${input.windowId}, ${admitted ? 1 : 0},
              ${admitted ? 0 : 1}, ${admitted ? null : input.rateLimitAuditId}, ${input.now}
            )
            ON CONFLICT (integration_id) DO UPDATE SET
              window_id = excluded.window_id,
              admitted_count = ${admitted ? admittedCount + 1 : admittedCount},
              rejected_count = ${admitted ? rejectedCount : rejectedCount + 1},
              rejection_audit_id = ${admitted ? null : input.rateLimitAuditId},
              updated_at = excluded.updated_at
          `;
          if (admitted) {
            yield* sql`
              INSERT INTO external_mcp_audit_log (
                audit_id, integration_id, tool, request_id, project_id, runtime_mode,
                environment, outcome, created_task_ids_json, detail, created_at
              ) VALUES (
                ${input.auditId}, ${input.integrationId}, ${input.tool}, ${input.requestId},
                ${input.projectId}, ${input.runtimeMode}, ${input.environment},
                'started', '[]', NULL, ${input.now}
              )
            `;
          } else {
            yield* sql`
              INSERT INTO external_mcp_audit_log (
                audit_id, integration_id, tool, request_id, project_id, runtime_mode,
                environment, outcome, created_task_ids_json, detail, created_at
              ) VALUES (
                ${input.rateLimitAuditId}, ${input.integrationId}, ${input.tool}, NULL, NULL, NULL,
                NULL, 'rate_limited', '[]', ${`Rejected ${rejectedCount + 1} calls in this window.`}, ${input.now}
              )
              ON CONFLICT (audit_id) DO UPDATE SET
                detail = ${`Rejected ${rejectedCount + 1} calls in this window.`}
            `;
          }
          return admitted;
        }),
      )
      .pipe(Effect.mapError(repositoryError("beginAudit")));

  const finishAudit: ExternalMcpRepositoryShape["finishAudit"] = (input) =>
    sql`
      UPDATE external_mcp_audit_log
      SET outcome = ${input.outcome},
          created_task_ids_json = ${JSON.stringify(input.createdTaskIds)},
          detail = ${input.detail ?? null}
      WHERE audit_id = ${input.auditId}
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("finishAudit")));

  const selectOperationBy = (where: ReturnType<typeof sql.literal>) => sql<OperationRow>`
    SELECT
      operation_id AS "operationId", integration_id AS "integrationId",
      'create_threads' AS "operationKind", request_id AS "requestId", fingerprint,
      requested_count AS "requestedCount", plan_json AS "planJson", status,
      result_json AS "resultJson", error_json AS "errorJson",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM external_mcp_operations
    WHERE ${where}
  `;

  const reserveOperation: ExternalMcpRepositoryShape["reserveOperation"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly operationId: string }>`
            INSERT INTO external_mcp_operations (
              operation_id, integration_id, request_id, fingerprint, requested_count,
              plan_json, status, result_json, error_json, created_at, updated_at
            )
            SELECT
              ${input.operationId}, ${input.integrationId}, ${input.requestId},
              ${input.fingerprint}, ${input.requestedCount}, ${input.planJson},
              'reserved', NULL, NULL, ${input.now}, ${input.now}
            FROM external_mcp_integrations AS integrations
            WHERE integrations.integration_id = ${input.integrationId}
              AND integrations.revoked_at IS NULL
              AND integrations.expires_at > ${input.now}
              AND (
                SELECT COUNT(*)
                FROM external_mcp_active_capacity_claims AS claims
                WHERE claims.integration_id = integrations.integration_id
              ) < integrations.concurrency_limit
            ON CONFLICT (integration_id, request_id) DO NOTHING
            RETURNING operation_id AS "operationId"
          `;
          const capacity = yield* sql<{
            readonly activeCount: number;
            readonly concurrencyLimit: number;
          }>`
            SELECT
              integrations.concurrency_limit AS "concurrencyLimit",
              (
                SELECT COUNT(*)
                FROM external_mcp_active_capacity_claims AS claims
                WHERE claims.integration_id = integrations.integration_id
              ) AS "activeCount"
            FROM external_mcp_integrations AS integrations
            WHERE integrations.integration_id = ${input.integrationId}
              AND integrations.revoked_at IS NULL
              AND integrations.expires_at > ${input.now}
            LIMIT 1
          `;
          const state = capacity[0];
          if (!state) {
            return yield* Effect.fail(new Error("External MCP integration is inactive."));
          }
          const rows = yield* selectOperationBy(
            sql`integration_id = ${input.integrationId} AND request_id = ${input.requestId}`,
          );
          const operation = rows[0];
          if (operation) {
            if (inserted.length > 0) {
              return { kind: "reserved", operation } satisfies ReserveExternalMcpOperationResult;
            }
            return operation.fingerprint === input.fingerprint
              ? ({ kind: "replay", operation } as const)
              : ({ kind: "idempotency_conflict", operation } as const);
          }
          return {
            kind: "concurrency_limited",
            activeCount: state.activeCount,
            limit: state.concurrencyLimit,
          } as const;
        }),
      )
      .pipe(Effect.mapError(repositoryError("reserveOperation")));

  const markOperationDispatching: ExternalMcpRepositoryShape["markOperationDispatching"] = (
    input,
  ) =>
    sql<{ readonly operationId: string }>`
      UPDATE external_mcp_operations SET status = 'dispatching', updated_at = ${input.now}
      WHERE operation_id = ${input.operationId} AND status = 'reserved'
      RETURNING operation_id AS "operationId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(repositoryError("markOperationDispatching")),
    );

  const recordOperationWorktreeCreated: ExternalMcpRepositoryShape["recordOperationWorktreeCreated"] =
    (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly planJson: string; readonly status: string }>`
              SELECT plan_json AS "planJson", status FROM external_mcp_operations
              WHERE operation_id = ${input.operationId} LIMIT 1
            `;
            const operation = rows[0];
            if (!operation || operation.status !== "dispatching") return false;
            const planJson = recordCreatedWorktreeInPlan({
              planJson: operation.planJson,
              operationId: input.operationId,
              index: input.index,
              workspaceRoot: input.workspaceRoot,
              path: input.path,
              branch: input.branch,
              token: input.token,
              gitDir: input.gitDir,
              head: input.head,
              ...(input.stateHash ? { stateHash: input.stateHash } : {}),
              recordedAt: input.now,
            });
            const updated = yield* sql<{ readonly operationId: string }>`
              UPDATE external_mcp_operations SET plan_json = ${planJson}, updated_at = ${input.now}
              WHERE operation_id = ${input.operationId}
                AND status = 'dispatching' AND plan_json = ${operation.planJson}
              RETURNING operation_id AS "operationId"
            `;
            return updated.length > 0;
          }),
        )
        .pipe(Effect.mapError(repositoryError("recordOperationWorktreeCreated")));

  const updateOperationStatus = (
    operation: string,
    input: { readonly operationId: string; readonly now: string },
    status: "compensating" | "failed",
    errorJson?: string,
  ) =>
    sql`
      UPDATE external_mcp_operations
      SET status = ${status}, updated_at = ${input.now}
        ${errorJson === undefined ? sql`` : sql`, error_json = ${errorJson}`}
      WHERE operation_id = ${input.operationId}
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError(operation)));

  const markOperationCompensating: ExternalMcpRepositoryShape["markOperationCompensating"] = (
    input,
  ) => updateOperationStatus("markOperationCompensating", input, "compensating");

  const recordOperationCompensationFailure: ExternalMcpRepositoryShape["recordOperationCompensationFailure"] =
    (input) =>
      updateOperationStatus(
        "recordOperationCompensationFailure",
        input,
        "compensating",
        input.errorJson,
      );

  const completeOperation: ExternalMcpRepositoryShape["completeOperation"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const completed = yield* sql<{ readonly operationId: string }>`
            UPDATE external_mcp_operations
            SET status = 'completed', result_json = ${input.resultJson}, error_json = NULL,
                updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
              AND status = 'dispatching'
              AND EXISTS (
                SELECT 1
                FROM external_mcp_integrations AS integrations
                WHERE integrations.integration_id = external_mcp_operations.integration_id
                  AND integrations.revoked_at IS NULL
                  AND integrations.expires_at > ${input.now}
              )
            RETURNING operation_id AS "operationId"
          `;
          if (completed.length > 0) return "completed" as const;

          // Revocation or expiry must still reject the final commit. Keep the
          // task non-terminal until the coordinator has attempted cleanup; the
          // capacity view conservatively owns its slot throughout compensation.
          // Returning the failure after the transaction commits lets the
          // coordinator compensate already-created resources.
          const compensating = yield* sql<{ readonly operationId: string }>`
            UPDATE external_mcp_operations
            SET status = 'compensating', result_json = NULL,
                error_json = ${JSON.stringify({
                  code: "integration_inactive_before_commit",
                  message: "External MCP integration became inactive before creation committed.",
                })},
                updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
              AND status = 'dispatching'
              AND NOT EXISTS (
                SELECT 1
                FROM external_mcp_integrations AS integrations
                WHERE integrations.integration_id = external_mcp_operations.integration_id
                  AND integrations.revoked_at IS NULL
                  AND integrations.expires_at > ${input.now}
              )
            RETURNING operation_id AS "operationId"
          `;
          if (compensating.length === 0) return "not_dispatching" as const;
          return "integration_inactive" as const;
        }),
      )
      .pipe(
        Effect.flatMap((outcome) =>
          outcome === "completed"
            ? Effect.void
            : Effect.fail(
                new Error(
                  outcome === "integration_inactive"
                    ? "External MCP integration became inactive before creation committed."
                    : "External MCP operation was not dispatching at creation commit.",
                ),
              ),
        ),
        Effect.mapError(repositoryError("completeOperation")),
      );

  const failOperation: ExternalMcpRepositoryShape["failOperation"] = (input) =>
    updateOperationStatus("failOperation", input, "failed", input.errorJson);

  const failOperationAndTask: ExternalMcpRepositoryShape["failOperationAndTask"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE external_mcp_tasks
            SET status = 'failed', updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
              AND status IN ('planned', 'created')
          `;
          yield* sql`
            UPDATE external_mcp_operations
            SET status = 'failed', error_json = ${input.errorJson}, updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
          `;
        }),
      )
      .pipe(Effect.mapError(repositoryError("failOperationAndTask")));

  const getOperationById: ExternalMcpRepositoryShape["getOperationById"] = (operationId) =>
    selectOperationBy(sql`operation_id = ${operationId}`).pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(repositoryError("getOperationById")),
    );

  const getOperationByRequest: ExternalMcpRepositoryShape["getOperationByRequest"] = (input) =>
    selectOperationBy(
      sql`integration_id = ${input.integrationId} AND request_id = ${input.requestId}`,
    ).pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(repositoryError("getOperationByRequest")),
    );

  const listNonTerminalOperations: ExternalMcpRepositoryShape["listNonTerminalOperations"] = () =>
    selectOperationBy(sql`status IN ('reserved', 'dispatching', 'compensating')`).pipe(
      Effect.mapError(repositoryError("listNonTerminalOperations")),
    );

  const registerTask: ExternalMcpRepositoryShape["registerTask"] = (input) =>
    sql`
      INSERT INTO external_mcp_tasks (
        integration_id, operation_id, request_id, thread_id, project_id,
        status, created_at, updated_at
      ) VALUES (
        ${input.integrationId}, ${input.operationId}, ${input.requestId}, ${input.threadId},
        ${input.projectId}, 'planned', ${input.now}, ${input.now}
      )
      ON CONFLICT (integration_id, thread_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("registerTask")));

  const markTaskStatus: ExternalMcpRepositoryShape["markTaskStatus"] = (input) =>
    sql`
      UPDATE external_mcp_tasks SET status = ${input.status}, updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
    `.pipe(Effect.asVoid, Effect.mapError(repositoryError("markTaskStatus")));

  const getTask: ExternalMcpRepositoryShape["getTask"] = (input) =>
    sql<ExternalMcpTaskRecord>`
      SELECT integration_id AS "integrationId", operation_id AS "operationId",
        request_id AS "requestId", thread_id AS "threadId", project_id AS "projectId",
        status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM external_mcp_tasks
      WHERE integration_id = ${input.integrationId} AND thread_id = ${input.threadId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(repositoryError("getTask")),
    );

  return {
    createIntegration,
    listIntegrations,
    getIntegrationById,
    getActiveIntegrationByCredentialHash,
    consumePairingCode,
    refreshPairingCode,
    revokeIntegration,
    touchLastUsed,
    beginAudit,
    finishAudit,
    reserveOperation,
    markOperationDispatching,
    recordOperationWorktreeCreated,
    markOperationCompensating,
    recordOperationCompensationFailure,
    completeOperation,
    failOperation,
    failOperationAndTask,
    getOperationById,
    getOperationByRequest,
    listNonTerminalOperations,
    registerTask,
    markTaskStatus,
    getTask,
  } satisfies ExternalMcpRepositoryShape;
});

export const ExternalMcpRepositoryLive = Layer.effect(
  ExternalMcpRepository,
  makeExternalMcpRepository,
);
