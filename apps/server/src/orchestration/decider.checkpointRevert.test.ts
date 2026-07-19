import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-checkpoint-revert");

const ACTIVE_TURN_ERROR =
  "Thread 'thread-checkpoint-revert' has an active turn. Interrupt the current turn before reverting checkpoints.";

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-checkpoint-revert"),
        title: "Checkpoint revert",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: input.latestTurn ?? null,
        handoff: null,
        messages: [],
        session: input.session === undefined ? null : input.session,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

function checkpointRevertCommand() {
  return {
    type: "thread.checkpoint.revert" as const,
    commandId: CommandId.makeUnsafe("cmd-checkpoint-revert"),
    threadId: THREAD_ID,
    turnCount: 1,
    scope: "thread" as const,
    createdAt: NOW,
  };
}

function makeSession(
  overrides: Partial<OrchestrationSession> & Pick<OrchestrationSession, "status">,
): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeLatestTurn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.makeUnsafe("turn-latest"),
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : NOW,
    assistantMessageId: null,
  };
}

describe("checkpoint revert decider", () => {
  it.each([
    {
      name: "starting",
      session: makeSession({ status: "starting" }),
      latestTurn: null,
    },
    {
      name: "running",
      session: makeSession({
        status: "running",
        activeTurnId: TurnId.makeUnsafe("turn-active"),
      }),
      latestTurn: null,
    },
    {
      name: "interrupted with an active turn",
      session: makeSession({
        status: "interrupted",
        activeTurnId: TurnId.makeUnsafe("turn-interrupting"),
      }),
      latestTurn: null,
    },
    {
      name: "ready with a still-running latest turn",
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("running"),
    },
  ])("rejects revert while the provider session is $name", async ({ session, latestTurn }) => {
    const error = await Effect.runPromise(
      Effect.flip(
        decideOrchestrationCommand({
          command: checkpointRevertCommand(),
          readModel: makeReadModel({ session, latestTurn }),
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.checkpoint.revert",
      detail: ACTIVE_TURN_ERROR,
    });
  });

  it.each([
    {
      name: "ready and idle",
      session: makeSession({ status: "ready" }),
      latestTurn: makeLatestTurn("completed"),
    },
    {
      name: "interrupted with no active turn",
      session: makeSession({ status: "interrupted" }),
      latestTurn: makeLatestTurn("interrupted"),
    },
    {
      name: "no session",
      session: null,
      latestTurn: null,
    },
  ])("emits the revert request when the thread is $name", async ({ session, latestTurn }) => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: checkpointRevertCommand(),
        readModel: makeReadModel({ session, latestTurn }),
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event).toMatchObject({
      type: "thread.checkpoint-revert-requested",
      payload: {
        threadId: THREAD_ID,
        turnCount: 1,
        scope: "thread",
      },
    });
  });
});
