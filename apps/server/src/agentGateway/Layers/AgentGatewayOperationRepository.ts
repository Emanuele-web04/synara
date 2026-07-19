import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AgentGatewayOperationRepository,
  type AgentGatewayOperationRecord,
  type AgentGatewayOperationRepositoryShape,
  type ReserveAgentGatewayOperationInput,
  type ReserveAgentGatewayOperationResult,
} from "../Services/AgentGatewayOperationRepository.ts";
import { recordCreatedWorktreeInPlan } from "../operationPlan.ts";

interface OperationRow {
  readonly operationId: string;
  readonly callerThreadId: string;
  readonly callerTurnId: string;
  readonly operationKind: "create_threads";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly requestedCount: number;
  readonly planJson: string;
  readonly status: AgentGatewayOperationRecord["status"];
  readonly resultJson: string | null;
  readonly errorJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const mapSqlError = (operation: string) => (cause: unknown) =>
  new Error(`Agent gateway operation repository failed during ${operation}.`, { cause });

export const makeAgentGatewayOperationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readByScope = (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly operationKind: "create_threads";
  }) =>
    sql<OperationRow>`
      SELECT
        operation_id AS "operationId",
        caller_thread_id AS "callerThreadId",
        caller_turn_id AS "callerTurnId",
        operation_kind AS "operationKind",
        request_id AS "requestId",
        fingerprint,
        requested_count AS "requestedCount",
        plan_json AS "planJson",
        status,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_gateway_operations
      WHERE caller_thread_id = ${input.callerThreadId}
        AND caller_turn_id = ${input.callerTurnId}
        AND operation_kind = ${input.operationKind}
      LIMIT 1
    `;

  const reserve: AgentGatewayOperationRepositoryShape["reserve"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly operationId: string }>`
            INSERT INTO agent_gateway_operations (
              operation_id,
              caller_thread_id,
              caller_turn_id,
              operation_kind,
              request_id,
              fingerprint,
              requested_count,
              plan_json,
              status,
              result_json,
              error_json,
              created_at,
              updated_at
            ) VALUES (
              ${input.operationId},
              ${input.callerThreadId},
              ${input.callerTurnId},
              ${input.operationKind},
              ${input.requestId},
              ${input.fingerprint},
              ${input.requestedCount},
              ${input.planJson},
              'reserved',
              NULL,
              NULL,
              ${input.now},
              ${input.now}
            )
            ON CONFLICT (caller_thread_id, caller_turn_id, operation_kind) DO NOTHING
            RETURNING operation_id AS "operationId"
          `;
          const [operation] = yield* readByScope(input);
          if (!operation) {
            return yield* Effect.fail(
              new Error("Reserved gateway operation could not be read back."),
            );
          }
          let kind: ReserveAgentGatewayOperationResult["kind"];
          if (inserted.length > 0) {
            kind = "reserved";
          } else if (operation.requestId === input.requestId) {
            kind = operation.fingerprint === input.fingerprint ? "replay" : "idempotency_conflict";
          } else {
            kind = "creation_plan_locked";
          }
          return { kind, operation } satisfies ReserveAgentGatewayOperationResult;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("reserve")));

  const markDispatching: AgentGatewayOperationRepositoryShape["markDispatching"] = (input) =>
    sql<{ readonly operationId: string }>`
      UPDATE agent_gateway_operations
      SET status = 'dispatching', updated_at = ${input.now}
      WHERE operation_id = ${input.operationId} AND status = 'reserved'
      RETURNING operation_id AS "operationId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapSqlError("markDispatching")),
    );

  const recordWorktreeCreated: AgentGatewayOperationRepositoryShape["recordWorktreeCreated"] = (
    input,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly planJson: string;
            readonly status: AgentGatewayOperationRecord["status"];
          }>`
            SELECT plan_json AS "planJson", status
            FROM agent_gateway_operations
            WHERE operation_id = ${input.operationId}
            LIMIT 1
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
            recordedAt: input.now,
          });
          const updated = yield* sql<{ readonly operationId: string }>`
            UPDATE agent_gateway_operations
            SET plan_json = ${planJson}, updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
              AND status = 'dispatching'
              AND plan_json = ${operation.planJson}
            RETURNING operation_id AS "operationId"
          `;
          return updated.length > 0;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("recordWorktreeCreated")));

  const complete: AgentGatewayOperationRepositoryShape["complete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE agent_gateway_operations
            SET status = 'completed', result_json = ${input.resultJson}, error_json = NULL,
                updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
          `;
          yield* sql`
            DELETE FROM agent_gateway_operations
            WHERE operation_id = ${input.operationId}
              AND caller_purged_at IS NOT NULL
          `;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("complete")));

  const markCompensating: AgentGatewayOperationRepositoryShape["markCompensating"] = (input) =>
    sql`
      UPDATE agent_gateway_operations
      SET status = 'compensating', updated_at = ${input.now}
      WHERE operation_id = ${input.operationId}
        AND status IN ('reserved', 'dispatching', 'compensating')
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("markCompensating")));

  const fail: AgentGatewayOperationRepositoryShape["fail"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE agent_gateway_operations
            SET status = 'failed', error_json = ${input.errorJson}, updated_at = ${input.now}
            WHERE operation_id = ${input.operationId}
          `;
          yield* sql`
            DELETE FROM agent_gateway_operations
            WHERE operation_id = ${input.operationId}
              AND caller_purged_at IS NOT NULL
          `;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("fail")));

  const getById: AgentGatewayOperationRepositoryShape["getById"] = (operationId) =>
    sql<OperationRow>`
      SELECT
        operation_id AS "operationId",
        caller_thread_id AS "callerThreadId",
        caller_turn_id AS "callerTurnId",
        operation_kind AS "operationKind",
        request_id AS "requestId",
        fingerprint,
        requested_count AS "requestedCount",
        plan_json AS "planJson",
        status,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_gateway_operations
      WHERE operation_id = ${operationId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(mapSqlError("getById")),
    );

  const getByScope: AgentGatewayOperationRepositoryShape["getByScope"] = (input) =>
    readByScope(input).pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(mapSqlError("getByScope")),
    );

  const listNonTerminal: AgentGatewayOperationRepositoryShape["listNonTerminal"] = () =>
    sql<OperationRow>`
      SELECT
        operation_id AS "operationId",
        caller_thread_id AS "callerThreadId",
        caller_turn_id AS "callerTurnId",
        operation_kind AS "operationKind",
        request_id AS "requestId",
        fingerprint,
        requested_count AS "requestedCount",
        plan_json AS "planJson",
        status,
        result_json AS "resultJson",
        error_json AS "errorJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_gateway_operations
      WHERE status IN ('reserved', 'dispatching', 'compensating')
      ORDER BY created_at ASC, operation_id ASC
    `.pipe(Effect.mapError(mapSqlError("listNonTerminal")));

  return {
    reserve,
    markDispatching,
    recordWorktreeCreated,
    markCompensating,
    complete,
    fail,
    getById,
    getByScope,
    listNonTerminal,
  } satisfies AgentGatewayOperationRepositoryShape;
});

export const AgentGatewayOperationRepositoryLive = Layer.effect(
  AgentGatewayOperationRepository,
  makeAgentGatewayOperationRepository,
);
