import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadCreatedPayload,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadSidechatContext,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-inbox");
const SIDECHAT_ID = ThreadId.makeUnsafe("thread-standalone-sidechat");
const CREATED_AT = "2026-09-30T10:00:00.000Z";
const EXPIRED_AT = "2026-09-30T11:00:00.000Z";
const CONTEXT: ThreadSidechatContext = {
  kind: "github-item",
  itemKind: "issue",
  repository: "octo/repo",
  number: 42,
  url: "https://github.com/octo/repo/issues/42",
};

type ThreadCreateCommand = Extract<OrchestrationCommand, { type: "thread.create" }>;

function createCommand(overrides: Partial<ThreadCreateCommand> = {}): ThreadCreateCommand {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe("cmd-standalone-sidechat"),
    threadId: SIDECHAT_ID,
    projectId: PROJECT_ID,
    title: "Sidechat: Crash on launch",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    lastKnownPr: null,
    sidechatContext: CONTEXT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

async function projectReadModel(): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(CREATED_AT), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-create"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: CREATED_AT,
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind: "project",
        title: "Repo",
        workspaceRoot: "/tmp/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    }),
  );
}

async function decide(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
  return (Array.isArray(result) ? result : [result]) as Array<Omit<OrchestrationEvent, "sequence">>;
}

async function readModelWithSidechat(): Promise<OrchestrationReadModel> {
  const base = await projectReadModel();
  const [created] = await decide(base, createCommand());
  return Effect.runPromise(projectEvent(base, { ...created, sequence: 2 } as OrchestrationEvent));
}

describe("standalone side chat decider", () => {
  it("creates a sidechat with its GitHub context and starts the inactivity clock", async () => {
    const [event] = await decide(await projectReadModel(), createCommand());

    expect(event).toMatchObject({
      type: "thread.created",
      payload: {
        threadId: SIDECHAT_ID,
        sidechatContext: CONTEXT,
        sidechatLastActivityAt: CREATED_AT,
        sidechatExpiredAt: null,
      },
    });
    const readModel = await readModelWithSidechat();
    const thread = readModel.threads.find((candidate) => candidate.id === SIDECHAT_ID);
    expect(thread?.sidechatContext).toEqual(CONTEXT);
    expect(thread?.sidechatSourceThreadId).toBeNull();
  });

  it.each([
    { name: "a parent thread", overrides: { parentThreadId: ThreadId.makeUnsafe("parent") } },
    { name: "a source thread", overrides: { sourceThreadId: ThreadId.makeUnsafe("source") } },
    { name: "a worktree", overrides: { envMode: "worktree", worktreePath: "/tmp/wt" } },
  ] as const)("rejects a standalone sidechat with $name", async ({ overrides }) => {
    await expect(
      decide(await projectReadModel(), createCommand(overrides as Partial<ThreadCreateCommand>)),
    ).rejects.toThrow(/standalone side chat/);
  });

  it("expires through the same lifecycle as forked sidechats", async () => {
    const readModel = await readModelWithSidechat();
    const [expired] = await decide(readModel, {
      type: "thread.sidechat.expire",
      commandId: CommandId.makeUnsafe("cmd-expire-standalone"),
      threadId: SIDECHAT_ID,
      expectedLastActivityAt: CREATED_AT,
      expiredAt: EXPIRED_AT,
    });
    expect(expired).toMatchObject({ type: "thread.sidechat-expired" });

    const afterExpiry = await Effect.runPromise(
      projectEvent(readModel, { ...expired, sequence: 3 } as OrchestrationEvent),
    );
    await expect(
      decide(afterExpiry, {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-expired-standalone"),
        threadId: SIDECHAT_ID,
        message: {
          messageId: MessageId.makeUnsafe("message-expired-standalone"),
          role: "user",
          text: "What changed?",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: EXPIRED_AT,
      }),
    ).rejects.toThrow("expired after a period of inactivity");
  });

  it("records activity on a standalone sidechat", async () => {
    const [event] = await decide(await readModelWithSidechat(), {
      type: "thread.sidechat.activity.record",
      commandId: CommandId.makeUnsafe("cmd-activity-standalone"),
      threadId: SIDECHAT_ID,
      activityAt: "2026-09-30T10:20:00.000Z",
    });
    expect(event).toMatchObject({
      type: "thread.sidechat-activity-recorded",
      payload: { lastActivityAt: "2026-09-30T10:20:00.000Z" },
    });
  });

  it("keeps ordinary threads out of the sidechat lifecycle", async () => {
    const base = await projectReadModel();
    const [created] = await decide(base, createCommand({ sidechatContext: undefined }));
    expect(created?.payload).not.toHaveProperty("sidechatContext");
    const readModel = await Effect.runPromise(
      projectEvent(base, { ...created, sequence: 2 } as OrchestrationEvent),
    );
    await expect(
      decide(readModel, {
        type: "thread.sidechat.activity.record",
        commandId: CommandId.makeUnsafe("cmd-activity-ordinary"),
        threadId: SIDECHAT_ID,
        activityAt: EXPIRED_AT,
      }),
    ).rejects.toThrow("is not a side chat");
  });

  it("replays thread.created events written before standalone sidechats with a null context", () => {
    const legacyPayload = {
      threadId: "thread-legacy",
      projectId: "project-legacy",
      title: "Legacy thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    const decoded = Schema.decodeUnknownSync(ThreadCreatedPayload)(legacyPayload);
    expect(decoded.sidechatContext).toBeNull();
    expect(decoded.sidechatSourceThreadId).toBeNull();
  });
});
