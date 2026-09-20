import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";
import { ThreadId, type OrchestrationCommand } from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentGatewayOperationRepositoryLive } from "./Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "./Services/AgentGatewayOperationRepository.ts";
import { makeCompletionRepository } from "./completionRepository.ts";
import { fingerprintOrchestrationCommand } from "../orchestration/commandFingerprint.ts";
import { deliverGatewayCompletions } from "./completionDelivery.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

const now = "2026-09-20T10:00:00.000Z";
const layer = it.layer(
  AgentGatewayOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const reserve = (id: string, notify = true) =>
  Effect.gen(function* () {
    const repository = yield* AgentGatewayOperationRepository;
    yield* repository.reserve({
      operationId: id,
      callerThreadId: "parent",
      callerTurnId: id,
      operationKind: "create_threads",
      requestId: id,
      fingerprint: id,
      requestedCount: 1,
      planJson: JSON.stringify([
        { notifyCreatorOnComplete: notify, ids: { threadId: id, messageId: `${id}:initial` } },
      ]),
      now,
    });
    yield* repository.complete({ operationId: id, resultJson: "{}", now });
    return repository.completions;
  });

layer("gateway completion outbox", (it) => {
  it.effect(
    "creates only opt-in routes, bound to the creator and initial message, idempotently",
    () =>
      Effect.gen(function* () {
        const repository = yield* reserve("opt-in");
        yield* reserve("ordinary", false);
        yield* reserve("opt-in");
        expect(yield* repository.pending()).toEqual([
          {
            childThreadId: "opt-in",
            creatorThreadId: "parent",
            initialMessageId: "opt-in:initial",
            resultJson: null,
            createdAt: now,
          },
        ]);
        yield* repository.delivered("opt-in", false);
      }),
  );

  it.effect("retains bounded context on rejection and freezes assignments across retries", () =>
    Effect.gen(function* () {
      const repository = yield* reserve("first");
      yield* repository.saveResult("first", JSON.stringify({ summary: "first result" }));
      yield* repository.delivered("first", true);
      expect(yield* repository.claimContext("other-parent", 1, 16000)).toBe("");
      expect(yield* repository.claimContext("parent", 1, 1)).toBe("");
      const first = yield* repository.claimContext("parent", 1, 16000);
      yield* reserve("second");
      yield* repository.saveResult("second", JSON.stringify({ summary: "second result" }));
      yield* repository.delivered("second", true);
      expect(yield* repository.claimContext("parent", 1, 16000)).toBe(first);
      yield* repository.settleContext(1, false, Effect.succeed(true));
      const next = yield* repository.claimContext("parent", 2, 16000);
      expect(next).toContain("first result");
      expect(next).toContain("second result");
      expect(next).toContain("untrusted child output");
      // A failed receipt settlement cannot consume results.
      yield* repository.settleContext(2, true, Effect.succeed(false));
      expect(yield* repository.claimContext("parent", 2, 16000)).toBe(next);
      yield* repository.settleContext(2, true, Effect.succeed(true));
      expect(yield* repository.claimContext("parent", 3, 16000)).toBe("");
    }),
  );

  for (const state of ["completed", "error", "interrupted", "running"] as const) {
    for (const parentState of ["idle", "running", "archived", "missing"] as const) {
      it.effect(
        `${state}: passive delivery with ${parentState} creator and later unrelated turns`,
        () =>
          Effect.gen(function* () {
            const id = `${state}-${parentState}`;
            const sequence =
              100 +
              ["completed", "error", "interrupted", "running"].indexOf(state) * 4 +
              ["idle", "running", "archived", "missing"].indexOf(parentState);
            const repository = yield* reserve(id);
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO provider_runtime_events
            (event_id, thread_id, turn_id, event_type, event_json, persisted_at)
            VALUES (${id}, ${id}, 'initial-run', 'turn.completed', '{"payload":{"state":"completed"}}', ${now})`;
            yield* sql`UPDATE provider_runtime_event_consumers SET last_acked_sequence = (SELECT MAX(sequence) FROM provider_runtime_events)`;
            const commands: OrchestrationCommand[] = [];
            const child = {
              id: ThreadId.makeUnsafe(id),
              modelSelection: { provider: "codex", model: "test-model" },
              latestTurn: { turnId: "later-run" },
              session: { status: "error", lastError: "unrelated later error" },
              messages: [
                { role: "assistant", turnId: "initial-run", text: "x".repeat(30_000) },
                { role: "assistant", turnId: "later-run", text: "wrong result" },
              ],
            };
            const dependencies = {
              repository,
              snapshotQuery: {
                getThreadDetailById: () => Effect.succeed(Option.some(child)),
                getThreadShellById: (threadId: string) =>
                  threadId === id
                    ? Effect.succeed(Option.some(child))
                    : Effect.succeed(
                        parentState === "missing"
                          ? Option.none()
                          : Option.some({
                              id: "parent",
                              archivedAt: parentState === "archived" ? now : null,
                              session: { status: parentState },
                            }),
                      ),
              } as unknown as ProjectionSnapshotQueryShape,
              projectionTurns: {
                listByThreadId: () =>
                  Effect.succeed([
                    {
                      pendingMessageId: `${id}:initial`,
                      turnId: "initial-run",
                      state,
                      completedAt: now,
                    },
                    {
                      pendingMessageId: "later-message",
                      turnId: "later-run",
                      state: "completed",
                      completedAt: now,
                    },
                  ]),
              } as unknown as ProjectionTurnRepositoryShape,
              orchestrationEngine: {
                dispatch: (command: OrchestrationCommand) =>
                  Effect.sync(() => {
                    commands.push(command);
                    return { sequence: commands.length };
                  }),
              } as unknown as OrchestrationEngineShape,
            };
            yield* deliverGatewayCompletions(dependencies);
            yield* deliverGatewayCompletions(dependencies);
            if (state === "running") {
              expect(commands).toHaveLength(0);
              expect(yield* repository.pending()).toHaveLength(1);
              yield* repository.delivered(id, false);
              return;
            }
            expect(commands).toHaveLength(1);
            expect(commands[0]?.type).toBe("thread.activity.append");
            const command = commands[0];
            if (command?.type !== "thread.activity.append") throw new Error("missing activity");
            const unavailable = parentState === "archived" || parentState === "missing";
            expect(command.threadId).toBe(unavailable ? id : "parent");
            expect(command.activity.turnId).toBeNull();
            expect(command.activity.payload).toMatchObject({
              runId: "initial-run",
              status: state,
              summaryTruncated: true,
            });
            expect(JSON.stringify(command.activity.payload)).not.toContain("wrong result");
            expect(JSON.stringify(command.activity.payload)).not.toContain("unrelated later error");
            expect(yield* repository.pending()).toHaveLength(0);
            expect((yield* repository.claimContext("parent", sequence, 16000)).length > 0).toBe(
              !unavailable,
            );
            yield* repository.settleContext(sequence, true, Effect.succeed(true));
          }),
      );
    }
  }

  it.effect(
    "requires real completion and durable output acknowledgement, not idle or approval waits",
    () =>
      Effect.gen(function* () {
        const repository = yield* reserve("terminal-proof");
        const sql = yield* SqlClient.SqlClient;
        expect(yield* repository.hasCompletedRun("terminal-proof", "run")).toBe(false);
        yield* sql`INSERT INTO provider_runtime_events (event_id, thread_id, turn_id, event_type, event_json, persisted_at)
      VALUES ('terminal-proof', 'terminal-proof', 'run', 'turn.completed', '{"payload":{"state":"completed"}}', ${now})`;
        expect(yield* repository.isOutputSettled("terminal-proof")).toBe(false);
        expect(yield* repository.hasCompletedRun("terminal-proof", "other-run")).toBe(false);
        yield* sql`UPDATE provider_runtime_event_consumers SET last_acked_sequence = (SELECT MAX(sequence) FROM provider_runtime_events)`;
        expect(yield* repository.isOutputSettled("terminal-proof")).toBe(true);
        expect(yield* repository.hasCompletedRun("terminal-proof", "run")).toBe(true);
        yield* repository.delivered("terminal-proof", false);
      }),
  );

  it.effect("pins pre-start failures and goal history before later conversational turns", () =>
    Effect.gen(function* () {
      const repository = yield* reserve("history");
      const sql = yield* SqlClient.SqlClient;
      const append = (version: number, type: string, payload: object, occurredAt = now) => sql`
      INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${"history-event-" + version}, 'thread', 'history', ${version}, ${type}, ${occurredAt}, 'system', ${JSON.stringify(payload)}, '{}')`;
      yield* append(0, "thread.turn-start-requested", { messageId: "history:initial" });
      yield* append(1, "thread.session-set", {
        session: { status: "error", lastError: "initial startup failed" },
      });
      yield* append(2, "thread.turn-start-requested", { messageId: "later-message" });
      yield* append(3, "thread.session-set", {
        session: { status: "error", lastError: "later error" },
      });
      yield* append(4, "thread.meta-updated", { goal: "keep going" }, "2026-09-20T11:00:00.000Z");
      expect(yield* repository.initialFailure("history", "history:initial")).toEqual({
        status: "error",
        error: "initial startup failed",
        completedAt: now,
      });
      expect(yield* repository.initialFailure("history", "unknown-message")).toBeNull();
      expect(yield* repository.hasGoalHistory("history", now)).toBe(false);
      expect(yield* repository.hasGoalHistory("history", "2026-09-20T12:00:00.000Z")).toBe(true);
      yield* repository.delivered("history", false);
    }),
  );

  it.effect("replays the same receipt after a delivery crash and keeps the frozen result", () =>
    Effect.gen(function* () {
      const repository = yield* reserve("replay");
      yield* repository.saveResult(
        "replay",
        JSON.stringify({
          status: "completed",
          summary: "durable original",
          error: null,
          completedAt: now,
        }),
      );
      yield* repository.saveResult("replay", "must not replace first result");
      const rows = yield* repository.pending();
      expect(rows[0]?.resultJson).toContain("durable original");
      const receipts = new Map<string, string>();
      let attempts = 0;
      const dependencies = {
        repository,
        snapshotQuery: {
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.some({ archivedAt: null })),
        } as unknown as ProjectionSnapshotQueryShape,
        projectionTurns: {} as ProjectionTurnRepositoryShape,
        orchestrationEngine: {
          dispatch: (command: OrchestrationCommand) =>
            Effect.suspend(() => {
              const fingerprint = fingerprintOrchestrationCommand(command).value;
              if (command.type !== "thread.activity.append") throw new Error("unexpected command");
              expect(command.createdAt).toBe(now);
              expect(command.activity.createdAt).toBe(now);
              const previous = receipts.get(command.commandId);
              if (previous !== undefined) expect(fingerprint).toBe(previous);
              receipts.set(command.commandId, fingerprint);
              attempts += 1;
              return attempts === 1
                ? Effect.fail(new Error("lost acknowledgement after commit"))
                : Effect.succeed({ sequence: 1 });
            }),
        } as unknown as OrchestrationEngineShape,
      };
      yield* deliverGatewayCompletions(dependencies);
      expect(yield* repository.pending()).toHaveLength(1);
      // Reconstruct the repository as a restarted server would; it has no memory of the first attempt.
      const restarted = yield* makeCompletionRepository;
      yield* deliverGatewayCompletions({ ...dependencies, repository: restarted });
      expect(receipts.size).toBe(1);
      expect(attempts).toBe(2);
      expect(yield* restarted.pending()).toHaveLength(0);
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql`SELECT context_consumed FROM agent_gateway_completions WHERE child_thread_id = 'replay'`)[0],
      ).toMatchObject({ context_consumed: 0 });
    }),
  );
});
