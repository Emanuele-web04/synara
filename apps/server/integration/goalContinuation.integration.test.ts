import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ORCHESTRATION_GOAL_COMPLETION_SENTINEL,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-goal");
const THREAD_ID = ThreadId.makeUnsafe("thread-goal");

function nowIso() {
  return new Date().toISOString();
}

function runtimeBase(eventId: string, createdAt: string) {
  return { eventId: EventId.makeUnsafe(eventId), provider: "codex" as const, createdAt };
}

function withHarness<A, E>(use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: "codex" }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = nowIso();
    const defaultModel = DEFAULT_MODEL_BY_PROVIDER.codex;
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-goal-project-create"),
      projectId: PROJECT_ID,
      title: "Goal Project",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: { provider: "codex", model: defaultModel },
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-goal-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Goal Thread",
      modelSelection: { provider: "codex", model: defaultModel },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

function turnResponse(input: { prefix: string; turnId: string; text: string }): TestTurnResponse {
  return {
    events: [
      {
        type: "turn.started",
        ...runtimeBase(`${input.prefix}-started`, "2026-06-02T10:00:00.000Z"),
        threadId: THREAD_ID,
        turnId: input.turnId,
      },
      {
        type: "message.delta",
        ...runtimeBase(`${input.prefix}-delta`, "2026-06-02T10:00:00.100Z"),
        threadId: THREAD_ID,
        turnId: input.turnId,
        delta: input.text,
      },
      {
        type: "turn.completed",
        ...runtimeBase(`${input.prefix}-completed`, "2026-06-02T10:00:00.200Z"),
        threadId: THREAD_ID,
        turnId: input.turnId,
        status: "completed",
      },
    ],
  };
}

it.live(
  "drives a goal: a non-completing turn auto-continues, and a sentinel turn completes the goal",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);

        // Create the goal before the first turn runs.
        yield* harness.engine.dispatch({
          type: "thread.goal.create",
          commandId: CommandId.makeUnsafe("cmd-goal-create"),
          threadId: THREAD_ID,
          goalId: "goal-e2e-1",
          objective: "Make all tests pass",
          createdAt: nowIso(),
        });

        // Turn 1 (the user's turn): does not emit the sentinel -> reactor should continue.
        yield* harness.adapterHarness!.queueTurnResponseForNextSession(
          turnResponse({
            prefix: "goal-turn-1",
            turnId: "goal-turn-1",
            text: "Working on it; not done yet.\n",
          }),
        );
        // Turn 2 (the reactor-injected continuation): emits the sentinel -> reactor completes.
        // Both responses are queued before the session starts; the adapter moves them into
        // the session queue and consumes one per turn (turn 1, then the continuation turn).
        yield* harness.adapterHarness!.queueTurnResponseForNextSession(
          turnResponse({
            prefix: "goal-turn-2",
            turnId: "goal-turn-2",
            text: `Completion audit passed.\n${ORCHESTRATION_GOAL_COMPLETION_SENTINEL}\n`,
          }),
        );

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-goal-turn-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("msg-goal-objective"),
            role: "user",
            text: "Make all tests pass",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: nowIso(),
        });

        // The reactor should inject a continuation turn, then complete the goal when the
        // sentinel turn lands.
        const thread = yield* harness.waitForThread(
          THREAD_ID,
          (entry) => entry.goal?.status === "complete",
          15_000,
        );

        assert.equal(thread.goal?.status, "complete");
        // At least one hidden continuation turn was injected by the reactor.
        assert.isTrue((thread.goal?.continuationCount ?? 0) >= 1);
        // The continuation was tagged with the new contract field so the UI can hide it.
        assert.isTrue(thread.messages.some((message) => message.source === "goal-continuation"));
      }),
    ),
);

it.live("continues after a fresh user turn even when a prior continuation was suppressed", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProjectAndThread(harness);

      yield* harness.engine.dispatch({
        type: "thread.goal.create",
        commandId: CommandId.makeUnsafe("cmd-goal-create-after-suppression"),
        threadId: THREAD_ID,
        goalId: "goal-e2e-after-suppression",
        objective: "Finish the follow-up work",
        createdAt: nowIso(),
      });

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        turnResponse({
          prefix: "goal-suppression-turn-1",
          turnId: "goal-suppression-turn-1",
          text: "I started, but there is still follow-up work.\n",
        }),
      );
      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        turnResponse({
          prefix: "goal-suppression-turn-2",
          turnId: "goal-suppression-turn-2",
          text: "Still not complete, but I did not use a tool.\n",
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-goal-suppression-initial-turn"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("msg-goal-suppression-objective"),
          role: "user",
          text: "Finish the follow-up work",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: nowIso(),
      });

      yield* harness.waitForThread(
        THREAD_ID,
        (entry) =>
          entry.goal?.status === "active" &&
          (entry.goal.continuationCount ?? 0) === 1 &&
          entry.latestTurn?.state === "completed",
        15_000,
      );

      yield* harness.adapterHarness!.queueTurnResponse(
        THREAD_ID,
        turnResponse({
          prefix: "goal-suppression-turn-3",
          turnId: "goal-suppression-turn-3",
          text: "Thanks for the nudge. I still need one more pass.\n",
        }),
      );
      yield* harness.adapterHarness!.queueTurnResponse(
        THREAD_ID,
        turnResponse({
          prefix: "goal-suppression-turn-4",
          turnId: "goal-suppression-turn-4",
          text: `The follow-up work is done.\n${ORCHESTRATION_GOAL_COMPLETION_SENTINEL}\n`,
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-goal-suppression-user-nudge"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("msg-goal-suppression-user-nudge"),
          role: "user",
          text: "Please keep going.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: nowIso(),
      });

      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.goal?.status === "complete",
        15_000,
      );

      assert.equal(thread.goal?.status, "complete");
      assert.isTrue((thread.goal?.continuationCount ?? 0) >= 2);
    }),
  ),
);
