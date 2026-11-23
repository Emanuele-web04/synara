import {
  CommandId,
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
import { Effect } from "effect";
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
  it("plans the startup continuation as a resume that adds no chat message", async () => {
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
    expect(events.map((event) => event.type)).toEqual(["thread.goal-continuation-requested"]);
    expect(events[0]).toMatchObject({
      payload: {
        threadId: THREAD_ID,
        goalStartedAt: null,
        trigger: "manual-resume",
        sourceTurnId: RECORDED_TURN_ID,
        resumePrompt: "Continue where you left off.",
      },
    });
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

  it.each([
    { state: "interrupted", requestedAt: NOW },
    { state: "error", requestedAt: NOW },
    { state: "interrupted", requestedAt: BEFORE_RECORD },
  ] as const)(
    "rejects a planned continuation for a replacement ($state, requested $requestedAt)",
    async ({ state, requestedAt }) => {
      const plannedReadModel = makeReadModel({ latestTurn: makeLatestTurn("interrupted") });
      const plan = planQuitResumeTurns({
        record: {
          version: 1,
          recordId: "before-replacement",
          recordedAt: RECORDED_AT,
          continuationPrompt: "Continue where you left off.",
          threads: [{ threadId: THREAD_ID, turnId: RECORDED_TURN_ID }],
        },
        threads: plannedReadModel.threads,
        projects: [{ id: plannedReadModel.threads[0]!.projectId, deletedAt: null }],
        now: NOW,
      });
      expect(plan.commands).toHaveLength(1);
      const readModel = makeReadModel({
        latestTurn: {
          ...makeLatestTurn(state, TurnId.makeUnsafe("turn-replacement")),
          requestedAt,
        },
      });
      const result = await Effect.runPromise(
        Effect.result(decideOrchestrationCommand({ command: plan.commands[0]!, readModel })),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "OrchestrationCommandInvariantError",
          commandType: "thread.turn.resume",
          detail: "Thread 'thread-resume' started another turn after it was remembered for resume.",
        },
      });
    },
  );

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

const withThread = (
  readModel: OrchestrationReadModel,
  patch: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel => ({
  ...readModel,
  threads: [{ ...readModel.threads[0]!, ...patch }],
});

describe("decider thread.turn.resume", () => {
  const resume = (readModel: OrchestrationReadModel) =>
    decideOrchestrationCommand({
      command: {
        type: "thread.turn.resume",
        commandId: CommandId.makeUnsafe("cmd-turn-resume"),
        threadId: THREAD_ID,
        createdAt: NOW,
      },
      readModel,
    });

  it("asks the provider reactor to continue without a chat message", async () => {
    const decided = await Effect.runPromise(
      resume(makeReadModel({ latestTurn: makeLatestTurn("interrupted") })),
    );
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "thread.goal-continuation-requested",
      payload: {
        threadId: THREAD_ID,
        goalStartedAt: null,
        trigger: "manual-resume",
        sourceTurnId: RECORDED_TURN_ID,
        createdAt: NOW,
      },
    });
    expect(events[0]?.payload).not.toHaveProperty("resumePrompt");
  });

  it("leaves a request that never started a turn for the reactor to resend", async () => {
    const decided = await Effect.runPromise(resume(makeReadModel({ latestTurn: null })));
    const events = Array.isArray(decided) ? decided : [decided];
    expect(events[0]).toMatchObject({ type: "thread.goal-continuation-requested" });
    expect(events[0]?.payload).not.toHaveProperty("sourceTurnId");
  });

  it.each([
    [
      "a turn is in flight",
      makeReadModel({ latestTurn: makeLatestTurn("running") }),
      "Thread 'thread-resume' already has a turn in flight.",
    ],
    [
      "an approval is pending",
      withThread(makeReadModel({ latestTurn: makeLatestTurn("interrupted") }), {
        hasPendingApprovals: true,
      }),
      "Thread 'thread-resume' is waiting for an answer.",
    ],
    [
      "a usage-limit wait owns the resume",
      withThread(makeReadModel({ latestTurn: makeLatestTurn("interrupted") }), {
        usageLimitRecovery: {} as NonNullable<
          OrchestrationReadModel["threads"][number]["usageLimitRecovery"]
        >,
      }),
      "Thread 'thread-resume' resumes on its own after the usage limit.",
    ],
    [
      "the thread is a native subagent",
      withThread(makeReadModel({ latestTurn: makeLatestTurn("interrupted") }), {
        creationSource: "provider_native",
      }),
      "Subagent 'thread-resume' cannot be resumed.",
    ],
  ])("refuses when %s", async (_case, readModel, detail) => {
    const error = await Effect.runPromise(Effect.flip(resume(readModel)));
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.resume",
      detail,
    });
  });

  it("refuses an archived thread", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resume(makeReadModel({ latestTurn: makeLatestTurn("interrupted"), archivedAt: NOW })),
      ),
    );
    expect(error).toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
      commandType: "thread.turn.resume",
    });
  });
});
