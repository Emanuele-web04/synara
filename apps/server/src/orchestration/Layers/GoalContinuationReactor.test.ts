import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, PubSub, Ref, Scope, Stream } from "effect";

import { GoalContinuationReactor } from "../Services/GoalContinuationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { GoalContinuationReactorLive } from "./GoalContinuationReactor.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-goal-reactor");
const PROJECT_ID = ProjectId.makeUnsafe("project-goal-reactor");
const TURN_ID = TurnId.makeUnsafe("turn-goal-reactor");
const ASSISTANT_MESSAGE_ID = MessageId.makeUnsafe("msg-goal-reactor-assistant");

function makeThread(input: {
  readonly goalCreatedAt: string;
  readonly turnCompletedAt: string | null;
}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Goal Reactor Thread",
    modelSelection: { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: "/tmp/project",
    sidechatSourceThreadId: null,
    latestTurn: {
      turnId: TURN_ID,
      state: "completed",
      requestedAt: "2026-06-02T10:00:00.000Z",
      startedAt: "2026-06-02T10:00:01.000Z",
      completedAt: input.turnCompletedAt,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
    },
    createdAt: "2026-06-02T09:59:00.000Z",
    updatedAt: input.turnCompletedAt ?? "2026-06-02T10:00:00.000Z",
    deletedAt: null,
    handoff: null,
    messages: [
      {
        id: ASSISTANT_MESSAGE_ID,
        role: "assistant",
        text: "I am not done yet.",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: input.turnCompletedAt ?? "2026-06-02T10:00:00.000Z",
        updatedAt: input.turnCompletedAt ?? "2026-06-02T10:00:00.000Z",
      },
    ],
    proposedPlans: [],
    goal: {
      id: "goal-reactor",
      objective: "Keep working after restart",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      continuationCount: 0,
      timeUsedSeconds: 0,
      createdAt: input.goalCreatedAt,
      updatedAt: input.goalCreatedAt,
    },
    activities: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: null,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: input.turnCompletedAt ?? "2026-06-02T10:00:00.000Z",
    },
  };
}

function snapshotWithThread(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: thread.updatedAt,
  };
}

const unused = () => Effect.die("unused");

function makeLayer(
  thread: OrchestrationThread,
  commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  events: PubSub.PubSub<OrchestrationEvent>,
) {
  const snapshot = snapshotWithThread(thread);
  return GoalContinuationReactorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        getReadModel: () => Effect.succeed(snapshot),
        dispatch: (command: OrchestrationCommand) =>
          Ref.updateAndGet(commandsRef, (commands) => [...commands, command]).pipe(
            Effect.map((commands) => ({ sequence: commands.length })),
          ),
        repairState: () => Effect.succeed(snapshot),
        streamDomainEvents: Stream.fromPubSub(events),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getSnapshot: () => Effect.succeed(snapshot),
        getCommandReadModel: () => Effect.succeed(snapshot),
        getCounts: unused,
        getSnapshotSequence: unused,
        getShellSnapshot: unused,
        getActiveProjectByWorkspaceRoot: unused,
        getProjectShellById: unused,
        getFirstActiveThreadIdByProjectId: unused,
        getThreadCheckpointContext: unused,
        getFullThreadDiffContext: unused,
        getThreadShellById: unused,
        findSyntheticSubagentParentThread: unused,
        getThreadDetailById: (threadId) =>
          Effect.succeed(threadId === thread.id ? Option.some(thread) : Option.none()),
        getThreadDetailSnapshotById: unused,
      }),
    ),
  );
}

function runReactorForSnapshot(thread: OrchestrationThread) {
  return Effect.gen(function* () {
    const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    return yield* Effect.gen(function* () {
      const reactor = yield* GoalContinuationReactor;
      const scope = yield* Scope.make();

      yield* reactor.start().pipe(Scope.provide(scope));
      yield* reactor.drain;
      const commands = yield* Ref.get(commandsRef);
      yield* Scope.close(scope, Exit.void);
      return commands;
    }).pipe(Effect.provide(makeLayer(thread, commandsRef, events)));
  });
}

it.effect("seeds active goals from the persisted snapshot when the reactor starts", () =>
  Effect.gen(function* () {
    const commands = yield* runReactorForSnapshot(
      makeThread({
        goalCreatedAt: "2026-06-02T10:00:00.000Z",
        turnCompletedAt: "2026-06-02T10:00:05.000Z",
      }),
    );

    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.type, "thread.turn.start");
  }),
);

it.effect("ignores completed turns that predate the active goal", () =>
  Effect.gen(function* () {
    const commands = yield* runReactorForSnapshot(
      makeThread({
        goalCreatedAt: "2026-06-02T10:00:10.000Z",
        turnCompletedAt: "2026-06-02T10:00:05.000Z",
      }),
    );

    assert.equal(commands.length, 0);
  }),
);
