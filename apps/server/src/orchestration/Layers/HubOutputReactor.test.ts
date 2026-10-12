import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
} from "@synara/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { HubOutputReactor } from "../Services/HubOutputReactor.ts";
import { HubOutputReactorLive } from "./HubOutputReactor.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Hub output reactor expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("HubOutputReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<HubOutputReactor, unknown> | null = null;
  let scope: Scope.Closeable | null = null;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it.each([
    "prepared",
    "cancelled",
    "missing",
    "native-child",
    "already-skipped",
    "child-own-failure",
  ] as const)(
    "uses only a pre-dispatch Hub baseline when preparation is %s",
    async (preparation) => {
      const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "synara-studio-reactor-"));
      temporaryRoots.push(workspaceRoot);
      const threadId = ThreadId.makeUnsafe("studio-thread");
      const projectId = ProjectId.makeUnsafe("studio-project");
      const turnId = TurnId.makeUnsafe("studio-turn");
      const runtimeEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
      const commands: OrchestrationCommand[] = [];
      const messageId = MessageId.makeUnsafe("studio-message");
      const isChild = preparation === "native-child" || preparation === "child-own-failure";
      const initialNotice = {
        id: EventId.makeUnsafe("initial-studio-skip"),
        kind: "checkpoint.baseline.skipped",
        tone: "info",
        summary: "Turn continued without baselines",
        payload: {
          messageId,
          detail: "Checkpoint and Hub preparation both exceeded the deadline.",
        },
        turnId: null,
        createdAt: "2026-07-08T09:59:59.000Z",
      };
      const initialActivities = preparation === "already-skipped" ? [initialNotice] : [];

      const providerService = {
        streamEvents: Stream.fromPubSub(runtimeEvents),
      } as unknown as ProviderServiceShape;
      const orchestrationEngine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngineShape;
      const projectionSnapshotQuery = {
        getThreadShellById: () =>
          Effect.succeed(
            Option.some({
              id: threadId,
              projectId,
              parentThreadId: isChild ? ThreadId.makeUnsafe("parent-thread") : null,
              envMode: "local",
              worktreePath: null,
            } as never),
          ),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              id: threadId,
              projectId,
              parentThreadId: isChild ? ThreadId.makeUnsafe("parent-thread") : null,
              activities: initialActivities,
              messages: [],
            } as never),
          ),
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              kind: "studio",
              workspaceRoot,
            } as never),
          ),
        getSpaceShellById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQueryShape;

      const layer = HubOutputReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
        Layer.provideMerge(ProjectionTurnRepositoryLive),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
      );
      const testRuntime = ManagedRuntime.make(layer);
      runtime = testRuntime;
      const reactor = await runtime.runPromise(Effect.service(HubOutputReactor));
      if (
        preparation === "already-skipped" ||
        preparation === "child-own-failure" ||
        preparation === "cancelled"
      ) {
        await testRuntime.runPromise(
          Effect.gen(function* () {
            const turns = yield* ProjectionTurnRepository;
            yield* turns.upsertByTurnId({
              threadId,
              turnId,
              pendingMessageId: messageId,
              sourceProposedPlanThreadId: null,
              externalAgentRevisionId: null,
              spawningProfileId: null,
              sourceProposedPlanId: null,
              assistantMessageId: null,
              state: "running",
              requestedAt: "2026-07-08T09:59:59.000Z",
              startedAt: "2026-07-08T10:00:00.000Z",
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }),
        );
      }
      scope = await Effect.runPromise(Scope.make("sequential"));
      await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

      // This file appears after the command reactor's awaited preparation but before
      // the provider acknowledges turn.started. A turn.started-time scan would miss it.
      if (
        preparation === "prepared" ||
        preparation === "cancelled" ||
        preparation === "child-own-failure"
      ) {
        await runtime.runPromise(reactor.captureBaselineBeforeTurn(threadId));
      }
      if (preparation === "cancelled" || preparation === "child-own-failure") {
        await runtime.runPromise(reactor.cancelPendingTurnBaseline(threadId));
      }
      await writeFile(path.join(workspaceRoot, "report.md"), "finished report");

      await Effect.runPromise(
        PubSub.publish(runtimeEvents, {
          type: "turn.started",
          eventId: EventId.makeUnsafe("turn-started"),
          provider: "codex",
          threadId,
          turnId,
          createdAt: "2026-07-08T10:00:00.000Z",
          payload: {},
        }).pipe(Effect.asVoid),
      );
      if (preparation !== "prepared") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await Effect.runPromise(reactor.drain);
        await writeFile(path.join(workspaceRoot, "after-start.md"), "late output");
      }
      await Effect.runPromise(
        PubSub.publish(runtimeEvents, {
          type: "session.exited",
          eventId: EventId.makeUnsafe("session-exited"),
          provider: "codex",
          threadId,
          createdAt: "2026-07-08T10:00:01.000Z",
          payload: { reason: "provider crashed" },
        }).pipe(Effect.asVoid),
      );

      if (preparation !== "prepared") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await Effect.runPromise(reactor.drain);
        if (preparation === "native-child" || preparation === "already-skipped") {
          expect(commands).toEqual([]);
          if (preparation === "already-skipped")
            expect(initialActivities[0]?.payload.detail).toContain("both exceeded");
          return;
        }
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          type: "thread.activity.append",
          activity: {
            kind: "checkpoint.baseline.skipped",
            tone: "info",
            turnId,
            payload: { detail: expect.stringContaining("Hub") },
          },
        });
        return;
      }
      await waitFor(() => commands.length === 1);
      expect(commands[0]).toMatchObject({
        type: "thread.activity.append",
        threadId,
        activity: {
          kind: STUDIO_OUTPUTS_ACTIVITY_KIND,
          turnId,
          payload: {
            itemType: "studio_outputs",
            data: { files: [{ path: "report.md" }] },
          },
        },
      });
    },
  );
});
