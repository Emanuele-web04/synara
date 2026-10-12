import {
  CommandId,
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@synara/contracts";
import { deriveThreadSummaryMetadata } from "@synara/shared/threadSummary";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { planQuitResumeTurns } from "./quitResume.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const RECORDED_AT = "2026-07-18T23:00:00.000Z";
const BEFORE_RECORD = "2026-07-18T22:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-resume");
const RECORDED_TURN_ID = TurnId.makeUnsafe("turn-recorded");

function makeReadModel(input: {
  readonly session?: OrchestrationSession | null;
  readonly latestTurn?: OrchestrationLatestTurn | null;
  readonly archivedAt?: string;
  readonly runtimeMode?: OrchestrationReadModel["threads"][number]["runtimeMode"];
  readonly interactionMode?: OrchestrationReadModel["threads"][number]["interactionMode"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-resume"),
        title: "Resume",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: input.runtimeMode ?? "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: input.latestTurn ?? null,
        handoff: null,
        messages: [],
        session: input.session ?? null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
      },
    ],
  };
}

function makeLatestTurn(
  state: OrchestrationLatestTurn["state"],
  id: TurnId = RECORDED_TURN_ID,
  completedAt: string = NOW,
): OrchestrationLatestTurn {
  return {
    turnId: id,
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : completedAt,
    assistantMessageId: null,
  };
}

function resumeTurnStart(recordedTurnId: TurnId | null = RECORDED_TURN_ID): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-resume"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.makeUnsafe("message-resume"),
      role: "user",
      text: "Continue where you left off.",
      attachments: [],
    },
    dispatchMode: "queue",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    resumePrecondition: { recordedTurnId, recordedAt: RECORDED_AT },
    createdAt: NOW,
  };
}

const decide = (readModel: OrchestrationReadModel, recordedTurnId?: TurnId | null) =>
  decideOrchestrationCommand({ command: resumeTurnStart(recordedTurnId), readModel });

const expectAccepted = async (
  readModel: OrchestrationReadModel,
  recordedTurnId?: TurnId | null,
) => {
  const decided = await Effect.runPromise(decide(readModel, recordedTurnId));
  const events = Array.isArray(decided) ? decided : [decided];
  expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
};

const expectRejected = async (
  readModel: OrchestrationReadModel,
  detail: string,
  recordedTurnId?: TurnId | null,
) => {
  const error = await Effect.runPromise(Effect.flip(decide(readModel, recordedTurnId)));
  expect(error).toMatchObject({
    _tag: "OrchestrationCommandInvariantError",
    commandType: "thread.turn.start",
    detail,
  });
};

describe("decider thread.turn.start resumePrecondition", () => {
  it("checks external task write identity at serialized admission and strips client-supplied guards", async () => {
    const initial = makeReadModel({ runtimeMode: "approval-required" });
    const target = {
      ...initial.threads[0]!,
      creationSource: "external_mcp" as const,
      gatewayOperationId: "owned-operation",
      envMode: "worktree" as const,
      worktreePath: "/work/owned",
      workingDirectory: null,
    };
    const project = {
      id: target.projectId,
      title: "Owned",
      workspaceRoot: "/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const readModel = { ...initial, threads: [target], projects: [project] };
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("external-followup"),
      threadId: THREAD_ID,
      message: {
        messageId: MessageId.makeUnsafe("external-message"),
        role: "user" as const,
        text: "Continue",
        attachments: [],
      },
      dispatchMode: "queue" as const,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
      createdAt: NOW,
      taskWritePrecondition: {
        projectId: target.projectId,
        projectWorkspaceRoot: project.workspaceRoot,
        envMode: target.envMode,
        branch: target.branch,
        worktreePath: target.worktreePath,
        workingDirectory: null,
        runtimeMode: target.runtimeMode,
        interactionMode: target.interactionMode,
        modelSelection: target.modelSelection,
        sessionProviderInstanceId: null,
        sessionRuntimeMode: null,
        gatewayOperationId: target.gatewayOperationId,
      },
    };
    expect(
      Array.isArray(await Effect.runPromise(decideOrchestrationCommand({ command, readModel }))),
    ).toBe(true);
    expect(Schema.decodeUnknownSync(ClientOrchestrationCommand)(command)).not.toHaveProperty(
      "taskWritePrecondition",
    );
    for (const changed of [
      { ...target, archivedAt: NOW },
      { ...target, projectId: ProjectId.makeUnsafe("moved-outside-grant") },
      { ...target, worktreePath: "/work/changed" },
      { ...target, runtimeMode: "full-access" as const },
      { ...target, modelSelection: { ...target.modelSelection, instanceId: "codex:other" } },
    ]) {
      const rejected = await Effect.runPromise(
        decideOrchestrationCommand({
          command,
          readModel: { ...readModel, threads: [changed] },
        }).pipe(Effect.flip),
      );
      expect(rejected).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: expect.stringContaining("authorized task target changed"),
      });
    }
    const relocated = await Effect.runPromise(
      decideOrchestrationCommand({
        command,
        readModel: { ...readModel, projects: [{ ...project, workspaceRoot: "/moved-project" }] },
      }).pipe(Effect.flip),
    );
    expect(relocated).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
  });

  it("does not count an automatic startup continuation as a human send", async () => {
    const readModel = makeReadModel({ latestTurn: makeLatestTurn("interrupted") });
    const plan = planQuitResumeTurns({
      record: {
        version: 1,
        recordId: "recency",
        recordedAt: RECORDED_AT,
        continuationPrompt: "Continue where you left off.",
        threads: [{ threadId: THREAD_ID, turnId: RECORDED_TURN_ID }],
      },
      threads: readModel.threads,
      projects: [{ id: readModel.threads[0]!.projectId, deletedAt: null }],
      now: NOW,
    });
    expect(plan.commands).toHaveLength(1);
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({ command: plan.commands[0]!, readModel }),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const message = events.find((event) => event.type === "thread.message-sent");
    expect(message?.type).toBe("thread.message-sent");
    if (message?.type !== "thread.message-sent") return;
    expect(
      deriveThreadSummaryMetadata({
        messages: [{ role: "user", createdAt: BEFORE_RECORD }, message.payload],
        activities: [],
        proposedPlans: [],
        latestTurn: null,
      }).latestHumanMessageAt,
    ).toBe(BEFORE_RECORD);
  });

  it("accepts a chat that was still connecting when recorded", async () => {
    await expectAccepted(makeReadModel({ latestTurn: null }), null);
    await expectAccepted(
      makeReadModel({
        latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-older"), BEFORE_RECORD),
      }),
      null,
    );
  });

  it("rejects when a newer turn completed on its own since the record", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-newer")) }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
    );
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed", TurnId.makeUnsafe("turn-newer")) }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
      null,
    );
  });

  it("rejects when the recorded turn completed on its own", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("completed") }),
      "Thread 'thread-resume' finished on its own; there is nothing to resume.",
    );
  });

  it("rejects when a turn is in flight", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("running") }),
      "Thread 'thread-resume' already has a turn in flight.",
    );
  });

  it("rejects when the thread was archived", async () => {
    await expectRejected(
      makeReadModel({ latestTurn: makeLatestTurn("interrupted"), archivedAt: NOW }),
      "Thread 'thread-resume' was archived after it was remembered for resume.",
    );
  });

  it("uses permission and interaction modes changed before the serialized resume dispatch", async () => {
    const decided = await Effect.runPromise(
      decide(
        makeReadModel({
          latestTurn: makeLatestTurn("interrupted"),
          runtimeMode: "approval-required",
          interactionMode: "plan",
        }),
      ),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    const requested = events.find((event) => event.type === "thread.turn-start-requested");

    expect(requested).toMatchObject({
      type: "thread.turn-start-requested",
      payload: {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      },
    });
  });
});
