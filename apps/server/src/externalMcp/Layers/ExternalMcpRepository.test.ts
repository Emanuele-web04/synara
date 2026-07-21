import type { ExternalMcpClientKind } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { hashExternalMcpSecret } from "./ExternalMcpService.ts";
import { ExternalMcpRepository } from "../Services/ExternalMcpRepository.ts";
import { ExternalMcpRepositoryLive, makeExternalMcpRepository } from "./ExternalMcpRepository.ts";

const layer = it.layer(ExternalMcpRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const createIntegration = (
  repository: typeof ExternalMcpRepository.Service,
  suffix: string,
  clientKind: ExternalMcpClientKind = "other",
) =>
  repository.createIntegration({
    integrationId: `integration-${suffix}`,
    name: `Integration ${suffix}`,
    clientKind,
    audience: "synara.external-mcp",
    capabilities: ["projects:read", "tasks:create", "tasks:read", "tasks:wait"],
    projectIds: [`project-${suffix}`],
    pairingHash: hashExternalMcpSecret(`pair-${suffix}`),
    createdAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-08-20T00:00:00.000Z",
    pairingExpiresAt: "2026-07-20T00:10:00.000Z",
    rateLimitPerMinute: 2,
    concurrencyLimit: 1,
  });

layer("ExternalMcpRepository", (it) => {
  it.effect("stores only credential hashes and consumes pairing exactly once", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* createIntegration(repository, "hash");
      const rawCredential = "syn_mcp_v1_raw-secret-value";
      const credentialHash = hashExternalMcpSecret(rawCredential);
      const paired = yield* repository.consumePairingCode({
        pairingHash: hashExternalMcpSecret("pair-hash"),
        credentialHash,
        now: "2026-07-20T00:01:00.000Z",
      });
      assert.equal(paired?.credentialHash, credentialHash);
      assert.equal(
        (yield* repository.consumePairingCode({
          pairingHash: hashExternalMcpSecret("pair-hash"),
          credentialHash,
          now: "2026-07-20T00:02:00.000Z",
        }))?.credentialHash,
        credentialHash,
      );
      assert.isNull(
        yield* repository.consumePairingCode({
          pairingHash: hashExternalMcpSecret("pair-hash"),
          credentialHash: hashExternalMcpSecret("replacement"),
          now: "2026-07-20T00:03:00.000Z",
        }),
      );
      const stored = yield* sql<{ readonly credentialHash: string; readonly rawMatches: number }>`
        SELECT credential_hash AS "credentialHash",
          instr(COALESCE(credential_hash, ''), ${rawCredential}) AS "rawMatches"
        FROM external_mcp_integrations WHERE integration_id = 'integration-hash'
      `;
      expect(stored[0]).toEqual({ credentialHash, rawMatches: 0 });
    }),
  );

  it.effect("lists the persisted external client kind", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "listed-client-kind", "claudeDesktop");
      const integrations = yield* repository.listIntegrations();
      expect(
        integrations.find(
          (integration) => integration.integrationId === "integration-listed-client-kind",
        )?.clientKind,
      ).toBe("claudeDesktop");
    }),
  );

  it.effect("checks expiry and revocation immediately", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "lifecycle");
      const credentialHash = hashExternalMcpSecret("credential-lifecycle");
      yield* repository.consumePairingCode({
        pairingHash: hashExternalMcpSecret("pair-lifecycle"),
        credentialHash,
        now: "2026-07-20T00:01:00.000Z",
      });
      assert.isNotNull(
        yield* repository.getActiveIntegrationByCredentialHash({
          credentialHash,
          now: "2026-07-20T00:02:00.000Z",
        }),
      );
      assert.isNull(
        yield* repository.getActiveIntegrationByCredentialHash({
          credentialHash,
          now: "2026-09-20T00:00:00.000Z",
        }),
      );
      yield* repository.revokeIntegration({
        integrationId: "integration-lifecycle",
        revokedAt: "2026-07-20T00:03:00.000Z",
      });
      assert.isNull(
        yield* repository.getActiveIntegrationByCredentialHash({
          credentialHash,
          now: "2026-07-20T00:04:00.000Z",
        }),
      );
    }),
  );

  it.effect("scopes projects and owned tasks to the integration", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "owner-a");
      yield* createIntegration(repository, "owner-b");
      const baseOperation = {
        operationId: "external-operation-a",
        integrationId: "integration-owner-a",
        requestId: "request-a",
        fingerprint: "fingerprint-a",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      yield* repository.reserveOperation(baseOperation);
      yield* repository.registerTask({
        integrationId: "integration-owner-a",
        operationId: baseOperation.operationId,
        requestId: baseOperation.requestId,
        threadId: "thread-a",
        projectId: "project-owner-a",
        now: baseOperation.now,
      });
      yield* repository.markTaskStatus({
        operationId: baseOperation.operationId,
        status: "created",
        now: "2026-07-20T00:02:00.000Z",
      });
      assert.isNotNull(
        yield* repository.getTask({ integrationId: "integration-owner-a", threadId: "thread-a" }),
      );
      assert.isNull(
        yield* repository.getTask({ integrationId: "integration-owner-b", threadId: "thread-a" }),
      );
      expect((yield* repository.getIntegrationById("integration-owner-a"))?.projectIds).toEqual([
        "project-owner-a",
      ]);
    }),
  );

  it.effect("replays one request and rejects request-id reuse with a different plan", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "idempotency");
      const operation = {
        operationId: "external-operation-idempotent",
        integrationId: "integration-idempotency",
        requestId: "stable-request",
        fingerprint: "same-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(operation)).kind, "reserved");
      assert.equal(
        (yield* repository.reserveOperation({ ...operation, operationId: "ignored-retry" })).kind,
        "replay",
      );
      assert.equal(
        (yield* repository.reserveOperation({
          ...operation,
          operationId: "conflicting-retry",
          fingerprint: "different-plan",
        })).kind,
        "idempotency_conflict",
      );
    }),
  );

  it.effect("classifies the ON CONFLICT race fallback by the stored fingerprint", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "idempotency-race");
      const base = {
        integrationId: "integration-idempotency-race",
        requestId: "simultaneous-request",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      const results = yield* Effect.all(
        [
          repository.reserveOperation({
            ...base,
            operationId: "external-operation-race-a",
            fingerprint: "plan-a",
          }),
          repository.reserveOperation({
            ...base,
            operationId: "external-operation-race-b",
            fingerprint: "plan-b",
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.kind).toSorted()).toEqual([
        "idempotency_conflict",
        "reserved",
      ]);
      const reserved = results.find((result) => result.kind === "reserved");
      const conflict = results.find((result) => result.kind === "idempotency_conflict");
      expect(conflict?.operation.fingerprint).toBe(reserved?.operation.fingerprint);
      expect(conflict?.operation.operationId).toBe(reserved?.operation.operationId);
    }),
  );

  it.effect("exempts a simultaneous idempotent retry from capacity admission", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "idempotent-capacity");
      const operation = {
        integrationId: "integration-idempotent-capacity",
        requestId: "same-request",
        fingerprint: "same-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      const results = yield* Effect.all(
        [
          repository.reserveOperation({
            ...operation,
            operationId: "external-operation-idempotent-a",
          }),
          repository.reserveOperation({
            ...operation,
            operationId: "external-operation-idempotent-b",
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.map((result) => result.kind).toSorted()).toEqual(["replay", "reserved"]);
    }),
  );

  it.effect(
    "admits simultaneous request ids atomically under the integration concurrency limit",
    () =>
      Effect.gen(function* () {
        const repository = yield* ExternalMcpRepository;
        yield* createIntegration(repository, "concurrency");
        const operation = {
          operationId: "external-operation-first",
          integrationId: "integration-concurrency",
          requestId: "first-request",
          fingerprint: "first-plan",
          requestedCount: 1 as const,
          planJson: "[]",
          now: "2026-07-20T00:01:00.000Z",
        };
        const results = yield* Effect.all(
          [
            repository.reserveOperation(operation),
            repository.reserveOperation({
              ...operation,
              operationId: "external-operation-second",
              requestId: "second-request",
              fingerprint: "second-plan",
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.map((result) => result.kind).toSorted()).toEqual([
          "concurrency_limited",
          "reserved",
        ]);
        const limited = results.find((result) => result.kind === "concurrency_limited")!;
        assert.equal(limited.kind, "concurrency_limited");
        if (limited.kind === "concurrency_limited") {
          assert.equal(limited.activeCount, 1);
          assert.equal(limited.limit, 1);
        }
      }),
  );

  it.effect("keeps running-task capacity while its operation compensates after restart", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* createIntegration(repository, "running-capacity");
      const first = {
        operationId: "external-operation-running",
        integrationId: "integration-running-capacity",
        requestId: "running-request",
        fingerprint: "running-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(first)).kind, "reserved");
      assert.isTrue(
        yield* repository.markOperationDispatching({
          operationId: first.operationId,
          now: "2026-07-20T00:01:01.000Z",
        }),
      );
      yield* repository.registerTask({
        integrationId: first.integrationId,
        operationId: first.operationId,
        requestId: first.requestId,
        threadId: "external-running-thread",
        projectId: "project-running-capacity",
        now: "2026-07-20T00:01:02.000Z",
      });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, latest_turn_id,
          created_at, updated_at, deleted_at
        ) VALUES (
          'external-running-thread', 'project-running-capacity', 'Running external task',
          '{"provider":"codex","model":"gpt-5.5"}', 'external-running-turn',
          '2026-07-20T00:01:02.000Z', '2026-07-20T00:01:03.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'external-running-thread', 'external-running-turn', NULL, NULL, 'running',
          '2026-07-20T00:01:03.000Z', '2026-07-20T00:01:03.000Z', NULL, NULL,
          NULL, NULL, '[]'
        )
      `;
      yield* repository.markTaskStatus({
        operationId: first.operationId,
        status: "created",
        now: "2026-07-20T00:01:03.000Z",
      });
      yield* repository.markOperationCompensating({
        operationId: first.operationId,
        now: "2026-07-20T00:01:04.000Z",
      });
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'external-running-thread', NULL, NULL, NULL, 'completed',
          '2026-07-20T00:01:05.000Z', NULL, '2026-07-20T00:01:05.000Z', 1,
          'checkpoint-external-running', 'captured', '[]'
        )
      `;

      // A fresh repository value has no shared in-memory admission state. It
      // must reconstruct the occupied slot from durable task/turn projections.
      // The newer checkpoint-only row above must not mask the running turn.
      const restartedRepository = yield* makeExternalMcpRepository;
      const retry = yield* restartedRepository.reserveOperation({
        ...first,
        operationId: "ignored-running-retry",
      });
      assert.equal(retry.kind, "replay");
      const blocked = yield* restartedRepository.reserveOperation({
        ...first,
        operationId: "external-operation-blocked-by-running",
        requestId: "blocked-by-running-request",
        fingerprint: "blocked-by-running-plan",
      });
      assert.equal(blocked.kind, "concurrency_limited");
      if (blocked.kind === "concurrency_limited") {
        assert.equal(blocked.activeCount, 1);
        assert.equal(blocked.limit, 1);
      }

      yield* sql`
        UPDATE projection_turns
        SET state = 'completed', completed_at = '2026-07-20T00:02:00.000Z'
        WHERE thread_id = 'external-running-thread' AND turn_id = 'external-running-turn'
      `;
      const admitted = yield* restartedRepository.reserveOperation({
        ...first,
        operationId: "external-operation-after-terminal",
        requestId: "after-terminal-request",
        fingerprint: "after-terminal-plan",
        now: "2026-07-20T00:02:01.000Z",
      });
      assert.equal(admitted.kind, "reserved");
    }),
  );

  it.effect("keeps completed creation capacity while task projections lag", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* createIntegration(repository, "projection-lag-capacity");
      const first = {
        operationId: "external-operation-projection-lag",
        integrationId: "integration-projection-lag-capacity",
        requestId: "projection-lag-request",
        fingerprint: "projection-lag-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(first)).kind, "reserved");
      assert.isTrue(
        yield* repository.markOperationDispatching({
          operationId: first.operationId,
          now: "2026-07-20T00:01:01.000Z",
        }),
      );
      yield* repository.registerTask({
        integrationId: first.integrationId,
        operationId: first.operationId,
        requestId: first.requestId,
        threadId: "external-projection-lag-thread",
        projectId: "project-projection-lag-capacity",
        now: "2026-07-20T00:01:02.000Z",
      });
      yield* repository.markTaskStatus({
        operationId: first.operationId,
        status: "created",
        now: "2026-07-20T00:01:03.000Z",
      });
      yield* repository.completeOperation({
        operationId: first.operationId,
        resultJson: "{}",
        now: "2026-07-20T00:01:04.000Z",
      });
      const retry = {
        ...first,
        operationId: "external-operation-after-projection-lag",
        requestId: "after-projection-lag-request",
        fingerprint: "after-projection-lag-plan",
        now: "2026-07-20T00:01:05.000Z",
      };
      assert.equal((yield* repository.reserveOperation(retry)).kind, "concurrency_limited");

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, latest_turn_id,
          created_at, updated_at, deleted_at
        ) VALUES (
          'external-projection-lag-thread', 'project-projection-lag-capacity',
          'Projection lag task', '{"provider":"codex","model":"gpt-5.5"}', NULL,
          '2026-07-20T00:01:02.000Z', '2026-07-20T00:01:05.000Z', NULL
        )
      `;
      assert.equal((yield* repository.reserveOperation(retry)).kind, "concurrency_limited");

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at
        ) VALUES (
          'external-projection-lag-thread', 'error', 'codex', NULL,
          'Provider startup failed.', '2026-07-20T00:01:05.000Z'
        )
      `;
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM external_mcp_active_capacity_claims
          WHERE integration_id = ${first.integrationId}
        `,
      ).toEqual([{ count: 0 }]);
      yield* sql`
        UPDATE projection_thread_sessions
        SET status = 'starting', last_error = NULL
        WHERE thread_id = 'external-projection-lag-thread'
      `;
      assert.equal((yield* repository.reserveOperation(retry)).kind, "concurrency_limited");

      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, assistant_message_id, state,
          requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        ) VALUES (
          'external-projection-lag-thread', 'external-projection-lag-turn', NULL, NULL,
          'completed', '2026-07-20T00:01:06.000Z', '2026-07-20T00:01:06.000Z',
          '2026-07-20T00:01:07.000Z', NULL, NULL, NULL, '[]'
        )
      `;
      yield* sql`
        UPDATE projection_threads
        SET latest_turn_id = 'external-projection-lag-turn',
            updated_at = '2026-07-20T00:01:07.000Z'
        WHERE thread_id = 'external-projection-lag-thread'
      `;
      assert.equal((yield* repository.reserveOperation(retry)).kind, "reserved");
    }),
  );

  it.effect("releases a failed creation slot", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "failed-capacity");
      const first = {
        operationId: "external-operation-failed-slot",
        integrationId: "integration-failed-capacity",
        requestId: "failed-slot-request",
        fingerprint: "failed-slot-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(first)).kind, "reserved");
      yield* repository.failOperation({
        operationId: first.operationId,
        errorJson: JSON.stringify({ code: "dispatch_failed" }),
        now: "2026-07-20T00:01:01.000Z",
      });
      assert.equal(
        (yield* repository.reserveOperation({
          ...first,
          operationId: "external-operation-after-failure",
          requestId: "after-failure-request",
          fingerprint: "after-failure-plan",
        })).kind,
        "reserved",
      );
    }),
  );

  it.effect("keeps a compensating creation slot until cleanup becomes terminal", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "compensating-capacity");
      const first = {
        operationId: "external-operation-compensating-slot",
        integrationId: "integration-compensating-capacity",
        requestId: "compensating-slot-request",
        fingerprint: "compensating-slot-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(first)).kind, "reserved");
      assert.isTrue(
        yield* repository.markOperationDispatching({
          operationId: first.operationId,
          now: "2026-07-20T00:01:01.000Z",
        }),
      );
      yield* repository.registerTask({
        integrationId: first.integrationId,
        operationId: first.operationId,
        requestId: first.requestId,
        threadId: "external-compensating-thread",
        projectId: "project-compensating-capacity",
        now: "2026-07-20T00:01:02.000Z",
      });
      yield* repository.markOperationCompensating({
        operationId: first.operationId,
        now: "2026-07-20T00:01:03.000Z",
      });
      const retry = {
        ...first,
        operationId: "external-operation-after-compensation",
        requestId: "after-compensation-request",
        fingerprint: "after-compensation-plan",
        now: "2026-07-20T00:01:04.000Z",
      };
      assert.equal((yield* repository.reserveOperation(retry)).kind, "concurrency_limited");
      yield* repository.markTaskStatus({
        operationId: first.operationId,
        status: "failed",
        now: "2026-07-20T00:01:05.000Z",
      });
      assert.equal((yield* repository.reserveOperation(retry)).kind, "concurrency_limited");
      yield* repository.failOperation({
        operationId: first.operationId,
        errorJson: JSON.stringify({ code: "compensated" }),
        now: "2026-07-20T00:01:06.000Z",
      });
      assert.equal((yield* repository.reserveOperation(retry)).kind, "reserved");
    }),
  );

  it.effect("refuses the creation commit when revocation wins the final race", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* createIntegration(repository, "commit-revocation");
      const operation = {
        operationId: "external-operation-commit-revocation",
        integrationId: "integration-commit-revocation",
        requestId: "commit-revocation-request",
        fingerprint: "commit-revocation-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(operation)).kind, "reserved");
      assert.isTrue(
        yield* repository.markOperationDispatching({
          operationId: operation.operationId,
          now: "2026-07-20T00:01:01.000Z",
        }),
      );
      yield* repository.registerTask({
        integrationId: operation.integrationId,
        operationId: operation.operationId,
        requestId: operation.requestId,
        threadId: "external-revoked-thread",
        projectId: "project-commit-revocation",
        now: "2026-07-20T00:01:01.000Z",
      });
      yield* repository.markTaskStatus({
        operationId: operation.operationId,
        status: "created",
        now: "2026-07-20T00:01:01.000Z",
      });
      assert.isTrue(
        yield* repository.revokeIntegration({
          integrationId: operation.integrationId,
          revokedAt: "2026-07-20T00:01:02.000Z",
        }),
      );
      const revokedReplay = yield* repository
        .reserveOperation({ ...operation, operationId: "ignored-revoked-retry" })
        .pipe(Effect.exit);
      expect(revokedReplay._tag).toBe("Failure");
      const completion = yield* repository
        .completeOperation({
          operationId: operation.operationId,
          resultJson: "{}",
          now: "2026-07-20T00:01:03.000Z",
        })
        .pipe(Effect.exit);
      expect(completion._tag).toBe("Failure");
      expect((yield* repository.getOperationById(operation.operationId))?.status).toBe(
        "compensating",
      );
      expect(
        (yield* repository.getTask({
          integrationId: operation.integrationId,
          threadId: "external-revoked-thread",
        }))?.status,
      ).toBe("created");
      const activeClaims = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM external_mcp_active_capacity_claims
        WHERE integration_id = ${operation.integrationId}
      `;
      expect(activeClaims).toEqual([{ count: 1 }]);
      yield* repository.markTaskStatus({
        operationId: operation.operationId,
        status: "failed",
        now: "2026-07-20T00:01:04.000Z",
      });
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM external_mcp_active_capacity_claims
          WHERE integration_id = ${operation.integrationId}
        `,
      ).toEqual([{ count: 1 }]);
      yield* repository.failOperation({
        operationId: operation.operationId,
        errorJson: JSON.stringify({ code: "compensated" }),
        now: "2026-07-20T00:01:05.000Z",
      });
      expect(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM external_mcp_active_capacity_claims
          WHERE integration_id = ${operation.integrationId}
        `,
      ).toEqual([{ count: 0 }]);
    }),
  );

  it.effect("terminalizes an interrupted startup operation and its task atomically", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "startup-terminalization");
      const operation = {
        operationId: "external-operation-startup-terminalization",
        integrationId: "integration-startup-terminalization",
        requestId: "startup-terminalization-request",
        fingerprint: "startup-terminalization-plan",
        requestedCount: 1 as const,
        planJson: "[]",
        now: "2026-07-20T00:01:00.000Z",
      };
      assert.equal((yield* repository.reserveOperation(operation)).kind, "reserved");
      assert.isTrue(
        yield* repository.markOperationDispatching({
          operationId: operation.operationId,
          now: "2026-07-20T00:01:01.000Z",
        }),
      );
      yield* repository.registerTask({
        integrationId: operation.integrationId,
        operationId: operation.operationId,
        requestId: operation.requestId,
        threadId: "external-startup-terminalization-thread",
        projectId: "project-startup-terminalization",
        now: "2026-07-20T00:01:02.000Z",
      });

      yield* repository.failOperationAndTask({
        operationId: operation.operationId,
        errorJson: JSON.stringify({ code: "startup_recovery" }),
        now: "2026-07-20T00:01:03.000Z",
      });

      expect((yield* repository.getOperationById(operation.operationId))?.status).toBe("failed");
      expect(
        (yield* repository.getTask({
          integrationId: operation.integrationId,
          threadId: "external-startup-terminalization-thread",
        }))?.status,
      ).toBe("failed");
      expect(
        (yield* repository.reserveOperation({
          ...operation,
          operationId: "external-operation-after-startup-terminalization",
          requestId: "after-startup-terminalization-request",
          fingerprint: "after-startup-terminalization-plan",
          now: "2026-07-20T00:01:04.000Z",
        })).kind,
      ).toBe("reserved");
    }),
  );

  it.effect("enforces the per-minute audit admission limit", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      yield* createIntegration(repository, "rate");
      const start = (auditId: string) =>
        repository.beginAudit({
          auditId,
          integrationId: "integration-rate",
          tool: "synara_list_allowed_projects",
          requestId: null,
          projectId: null,
          runtimeMode: null,
          environment: null,
          now: "2026-07-20T00:01:30.000Z",
          windowId: Math.floor(Date.parse("2026-07-20T00:01:30.000Z") / 60_000),
          rateLimitAuditId: "audit-rate-window",
          retentionCutoff: "2026-06-20T00:00:00.000Z",
          rateLimitPerMinute: 2,
        });
      assert.isTrue(yield* start("audit-1"));
      assert.isTrue(yield* start("audit-2"));
      assert.isFalse(yield* start("audit-3"));
    }),
  );

  it.effect("aggregates rejected calls and prunes expired audit history", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* createIntegration(repository, "bounded-rate");
      yield* sql`
        INSERT INTO external_mcp_audit_log (
          audit_id, integration_id, tool, outcome, created_task_ids_json, created_at
        ) VALUES (
          'old-audit', 'integration-bounded-rate', 'old-tool', 'success', '[]',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      const windowId = Math.floor(Date.parse("2026-07-20T00:01:30.000Z") / 60_000);
      for (let index = 0; index < 100; index += 1) {
        yield* repository.beginAudit({
          auditId: `bounded-audit-${index}`,
          integrationId: "integration-bounded-rate",
          tool: "synara_list_allowed_projects",
          requestId: null,
          projectId: null,
          runtimeMode: null,
          environment: null,
          now: "2026-07-20T00:01:30.000Z",
          windowId,
          rateLimitAuditId: `bounded-rate-${windowId}`,
          retentionCutoff: "2026-06-20T00:00:00.000Z",
          rateLimitPerMinute: 2,
        });
      }
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM external_mcp_audit_log
        WHERE integration_id = 'integration-bounded-rate'
      `;
      expect(rows[0]?.count).toBe(3);
      const rejected = yield* sql<{ readonly rejectedCount: number }>`
        SELECT rejected_count AS "rejectedCount" FROM external_mcp_rate_windows
        WHERE integration_id = 'integration-bounded-rate'
      `;
      expect(rejected[0]?.rejectedCount).toBe(98);
    }),
  );
});
