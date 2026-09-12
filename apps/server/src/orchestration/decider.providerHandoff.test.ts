import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-09-10T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-provider-handoff");

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-provider-handoff"),
    title: "Continuous provider handoff",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    sidechatLastActivityAt: null,
    sidechatExpiredAt: null,
    lastKnownPr: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    archivedAt: null,
    settledAt: null,
    handoff: null,
    messages: [
      {
        id: MessageId.makeUnsafe("handoff-message"),
        role: "user",
        text: "Continue with another provider",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(overrides: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [makeThread(overrides)],
  };
}

function command(expectedSourceProvider: "claudeAgent" | "codex" = "claudeAgent") {
  return {
    type: "thread.provider.handoff" as const,
    commandId: CommandId.makeUnsafe("command-provider-handoff"),
    threadId: THREAD_ID,
    expectedSourceProvider,
    targetModelSelection: { provider: "grok" as const, model: "grok-code" },
    createdAt: NOW,
  };
}

describe("decider continuous provider handoff", () => {
  it("records a durable pending activity before the provider handoff intent", async () => {
    const events = await Effect.runPromise(
      decideOrchestrationCommand({ command: command(), readModel: makeReadModel() }),
    );

    expect(Array.isArray(events)).toBe(true);
    if (!Array.isArray(events)) return;
    expect(events.map((event) => event.type)).toEqual([
      "thread.activity-appended",
      "thread.provider-handoff-requested",
    ]);
    expect(events[0]?.payload).toMatchObject({
      activity: {
        kind: "provider.handoff.requested",
        payload: {
          handoffCommandId: "command-provider-handoff",
          targetModelSelection: { provider: "grok" },
        },
      },
    });
    expect(events[1]?.payload).toMatchObject({
      threadId: THREAD_ID,
      sourceModelSelection: { provider: "claudeAgent" },
      targetModelSelection: { provider: "grok" },
    });
  });

  it("rejects a message admitted immediately after a pending handoff", async () => {
    const pendingActivity = {
      id: EventId.makeUnsafe("provider-handoff-requested:command-provider-handoff"),
      tone: "info" as const,
      kind: "provider.handoff.requested",
      summary: "Switching to Grok",
      payload: {
        handoffCommandId: "command-provider-handoff",
        sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
        targetModelSelection: { provider: "grok", model: "grok-code" },
      },
      turnId: null,
      createdAt: NOW,
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("command-turn-during-handoff"),
            threadId: THREAD_ID,
            message: {
              messageId: MessageId.makeUnsafe("message-turn-during-handoff"),
              role: "user",
              text: "Did the provider switch yet?",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
          readModel: makeReadModel({ activities: [pendingActivity] }),
        }),
      ),
    ).rejects.toThrow("still switching to 'grok'");
  });

  it("rejects queued-turn promotion and checkpoint revert while a handoff is pending", async () => {
    const pendingActivity = {
      id: EventId.makeUnsafe("provider-handoff-requested:command-provider-handoff"),
      tone: "info" as const,
      kind: "provider.handoff.requested",
      summary: "Switching to Grok",
      payload: {
        handoffCommandId: "command-provider-handoff",
        sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
        targetModelSelection: { provider: "grok", model: "grok-code" },
      },
      turnId: null,
      createdAt: NOW,
    };
    const readModel = makeReadModel({ activities: [pendingActivity] });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.dispatch-queued",
            commandId: CommandId.makeUnsafe("command-promote-during-handoff"),
            threadId: THREAD_ID,
            messageId: MessageId.makeUnsafe("queued-message-during-handoff"),
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("still switching to 'grok'");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.checkpoint.revert",
            commandId: CommandId.makeUnsafe("command-revert-during-handoff"),
            threadId: THREAD_ID,
            turnCount: 1,
            scope: "thread",
            createdAt: NOW,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("still switching to 'grok'");
  });

  it("rejects a handoff while a checkpoint revert is pending", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: command(),
          readModel: makeReadModel({
            activities: [
              {
                id: EventId.makeUnsafe("checkpoint-revert-started"),
                tone: "info",
                kind: "checkpoint.revert.started",
                summary: "Reverting checkpoint",
                payload: { turnCount: 1, scope: "thread" },
                turnId: null,
                createdAt: NOW,
              },
            ],
          }),
        }),
      ),
    ).rejects.toThrow("checkpoint revert in progress");
  });

  it("completes a handoff by updating the provider before closing the pending activity", async () => {
    const events = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.provider.handoff.complete",
          commandId: CommandId.makeUnsafe("server:complete-provider-handoff"),
          threadId: THREAD_ID,
          handoffCommandId: CommandId.makeUnsafe("command-provider-handoff"),
          handoffEventId: EventId.makeUnsafe("event-provider-handoff"),
          sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
          targetModelSelection: { provider: "grok", model: "grok-code" },
          createdAt: NOW,
        },
        readModel: makeReadModel({
          activities: [
            {
              id: EventId.makeUnsafe("provider-handoff-requested:command-provider-handoff"),
              tone: "info",
              kind: "provider.handoff.requested",
              summary: "Switching to Grok",
              payload: {
                handoffCommandId: "command-provider-handoff",
                sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
                targetModelSelection: { provider: "grok", model: "grok-code" },
              },
              turnId: null,
              createdAt: NOW,
            },
          ],
        }),
      }),
    );

    expect(Array.isArray(events)).toBe(true);
    if (!Array.isArray(events)) return;
    expect(events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.activity-appended",
    ]);
    expect(events[0]?.payload).toMatchObject({
      modelSelection: { provider: "grok", model: "grok-code" },
    });
    expect(events[1]?.payload).toMatchObject({
      activity: {
        kind: "provider.handoff.completed",
        payload: { handoffCommandId: "command-provider-handoff" },
      },
    });
  });

  it("rejects a stale source provider", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: command("codex"), readModel: makeReadModel() }),
      ),
    ).rejects.toThrow("not expected source 'codex'");
  });

  it("rejects a handoff while a turn is running", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: command(),
          readModel: makeReadModel({
            session: {
              threadId: THREAD_ID,
              status: "running",
              providerName: "claudeAgent",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            },
          }),
        }),
      ),
    ).rejects.toThrow("has an active turn");
  });

  it("rejects a handoff with unresolved provider interaction", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: command(),
          readModel: makeReadModel({ hasPendingApprovals: true }),
        }),
      ),
    ).rejects.toThrow("pending provider interaction");
  });

  it("rejects a second handoff while the first is pending", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: command(),
          readModel: makeReadModel({
            activities: [
              {
                id: EventId.makeUnsafe("provider-handoff-requested:first"),
                tone: "info",
                kind: "provider.handoff.requested",
                summary: "Switching to Codex",
                payload: {
                  handoffCommandId: "first",
                  sourceModelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
                  targetModelSelection: { provider: "codex", model: "gpt-5.5" },
                },
                turnId: null,
                createdAt: NOW,
              },
            ],
          }),
        }),
      ),
    ).rejects.toThrow("still switching to 'codex'");
  });
});
