import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelSelection, ProviderRuntimeEvent, ProviderSession } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: modelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const steerTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>(() =>
      Effect.succeed(null),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const rollbackConversation = vi.fn<ProviderServiceShape["rollbackConversation"]>(
      () => Effect.void,
    );
    const restoreCheckpoint = vi.fn<CheckpointStoreShape["restoreCheckpoint"]>(() =>
      Effect.succeed(true),
    );
    const isGitRepository = vi.fn<CheckpointStoreShape["isGitRepository"]>(() =>
      Effect.succeed(false),
    );
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const stopRuntimeSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const clearSessionResumeCursor = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const publishBranch = vi.fn(() => Effect.void);
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview: unsupported as ProviderServiceShape["startReview"],
      forkThread,
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      stopRuntimeSession: stopRuntimeSession as NonNullable<
        ProviderServiceShape["stopRuntimeSession"]
      >,
      clearSessionResumeCursor: clearSessionResumeCursor as NonNullable<
        ProviderServiceShape["clearSessionResumeCursor"]
      >,
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(GitCore, { renameBranch, publishBranch } as unknown as GitCoreShape),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);
    const emitRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.runPromise(PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid));

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      startSession,
      sendTurn,
      steerTurn,
      forkThread,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      generateBranchName,
      generateThreadTitle,
      stateDir,
      drain,
      emitRuntimeEvent,
    };
  }

  async function seedRollbackTarget(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`cmd-import-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: input.messageId,
            role: "user",
            text: "rollback target",
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        ],
        createdAt: input.createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe(`cmd-assistant-complete-${input.messageId}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe(`assistant-${input.messageId}`),
        turnId: input.turnId,
        createdAt: input.createdAt,
      }),
    );
  }

  it("bootstraps sidechat context when the provider cannot fork natively", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-sidechat-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Sidechat: Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("sidechat-imported-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("sidechat-imported-assistant"),
            role: "assistant",
            text: "Earlier answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-sidechat-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        message: {
          messageId: asMessageId("sidechat-native-user"),
          role: "user",
          text: "Fresh side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.forkThread.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Earlier question");
    expect(input?.input).toContain("Earlier answer");
    expect(input?.input).toContain("<sidechat_boundary>");
    expect(input?.input).toContain("Fresh side question");
  });

  it("rolls back provider conversation state for message edits", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-2"),
      turnId: asTurnId("turn-rollback-2"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-2"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.rollbackConversation.mock.calls.length === 1);
    expect(harness.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("interrupts the active provider turn before rolling back an edited message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-active"),
      turnId: asTurnId("turn-rollback-active"),
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-rollback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-active-edit"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback-active"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-active"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.rollbackConversation.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-active-edit"),
    });
    expect(harness.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("stops an active provider runtime and immediately resends an edited latest message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "edit-image-1",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const skill = {
      name: "docs",
      path: "/tmp/docs-skill",
    };
    const mention = {
      name: "README.md",
      path: "/tmp/project/README.md",
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-original-turn-start-for-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-edit"),
          role: "user",
          text: "old prompt",
          attachments: [imageAttachment],
          skills: [skill],
          mentions: [mention],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    harness.startSession.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-active-edit-resend"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-edit"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopRuntimeSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.stopRuntimeSession.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.interruptTurn.mock.calls.length).toBe(0);
    expect(harness.rollbackConversation.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "edited prompt",
      attachments: [imageAttachment],
      skills: [skill],
      mentions: [mention],
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.messages.map((message) => message.text)).toEqual(["edited prompt"]);
    expect(thread?.messages[0]).toMatchObject({
      attachments: [imageAttachment],
      skills: [skill],
      mentions: [mention],
    });
  });

  it("keeps queued-message edits queued while an active provider turn continues", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-edit-queued"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running-edit-queued"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queued-before-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queued-before-edit"),
          role: "user",
          text: "queued prompt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.stopRuntimeSession.mockClear();
    harness.rollbackConversation.mockClear();
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-queued-message"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("msg-queued-before-edit"),
        text: "edited queued prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.rollbackConversation).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-edited-queue"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-edit-queued"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "edited queued prompt",
    });
  });

  it("preserves image attachment files while rolling back an edit resend", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "thread-1-12345678-1234-1234-1234-123456789abc",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const attachmentPath = path.join(
      harness.stateDir,
      "attachments",
      attachmentRelativePath(imageAttachment),
    );
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, Buffer.from([1, 2, 3, 4]));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-original-image-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-image-edit"),
          role: "user",
          text: "old image prompt",
          attachments: [imageAttachment],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-image-edit-assistant-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-image-edit"),
        turnId: asTurnId("turn-image-edit"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-image-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("msg-image-edit"),
        text: "edited image prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(fs.existsSync(attachmentPath)).toBe(true);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "edited image prompt",
      attachments: [imageAttachment],
    });
  });

  it("restores the previous filesystem checkpoint before resending a completed edit", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.isGitRepository.mockImplementationOnce(() => Effect.succeed(true));

    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-checkpoint-edit"),
      turnId: asTurnId("turn-checkpoint-edit"),
      createdAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-checkpoint-edit-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-checkpoint-edit"),
        completedAt: now,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        assistantMessageId: asMessageId("assistant-user-message-checkpoint-edit"),
        checkpointTurnCount: 1,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-checkpoint-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-checkpoint-edit"),
        text: "edited checkpoint prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.restoreCheckpoint).toHaveBeenCalledWith({
      cwd: "/tmp/provider-project",
      checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
      fallbackToHead: true,
    });
  });

  it("clears the edit loading state when provider rollback fails before resend", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/rollback",
          detail: "rollback failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-edit-rollback-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-edit-fails"),
            role: "user",
            text: "old prompt",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-edit-rollback-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-edit-rollback-failure"),
        turnId: asTurnId("turn-edit-rollback-failure"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend-rollback-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-edit-fails"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads[0]?.session?.status === "error";
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("rollback failed");
    expect(harness.sendTurn.mock.calls.length).toBe(0);
  });

  it("clears the edit loading state when edited turn start fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "turn start failed",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-edit-start-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-start-fails"),
            role: "user",
            text: "old prompt",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-edit-start-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-edit-start-failure"),
        turnId: asTurnId("turn-edit-start-failure"),
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-edit-and-resend-start-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-start-fails"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads[0]?.session?.status === "error";
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("turn start failed");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
  });

  it("clears stale provider resume state and completes message edit rollback", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-stale"),
      turnId: asTurnId("turn-rollback-stale"),
      createdAt: now,
    });
    harness.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/rollback",
          detail: "thread/resume failed: no rollout found for thread id 019db5ad",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.conversation.rollback",
        commandId: CommandId.makeUnsafe("cmd-conversation-rollback-stale-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("user-message-stale"),
        numTurns: 1,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.clearSessionResumeCursor.mock.calls.length === 1);
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("uses the runtime mode requested by thread.turn.start when starting the provider session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-full-access"),
          role: "user",
          text: "what permissions do you have",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: "full-access",
    });
  });

  it("does not pass the Home chat container workspace root through as provider cwd", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-home-project-create"),
        projectId: asProjectId("project-home"),
        kind: "chat",
        title: "Home",
        workspaceRoot: "/Users/tester",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-home-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-home"),
        projectId: asProjectId("project-home"),
        title: "Home thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-home-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-home"),
        message: {
          messageId: asMessageId("user-message-home-1"),
          role: "user",
          text: "hello from home chat",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("cwd");
  });

  it("renames a generic first-turn thread title using text generation", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Polish loading states",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-generic"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-1"),
          role: "user",
          text: "Polish the loading states across the sidebar and composer",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Polish loading states"
      );
    });
  });

  it("renames temporary worktree branches and keeps associated worktree metadata in sync", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({
        branch: "app-startup-crash",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "dpcode/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "dpcode/cb661f0d",
        associatedWorktreeRef: "dpcode/cb661f0d",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-rename"),
          role: "user",
          text: "The app crashes during startup, fix it",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(() => harness.publishBranch.mock.calls.length === 1);

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.branch === "dpcode/app-startup-crash" &&
        thread.associatedWorktreeBranch === "dpcode/app-startup-crash" &&
        thread.associatedWorktreeRef === "dpcode/app-startup-crash"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toMatchObject({
      branch: "dpcode/app-startup-crash",
      worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreeBranch: "dpcode/app-startup-crash",
      associatedWorktreeRef: "dpcode/app-startup-crash",
    });
  });

  it("passes OpenCode model selection and provider options into thread-title generation", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "opencode",
        model: "openai/gpt-5",
        options: {
          agent: "plan",
          variant: "balanced",
        },
      },
    });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Plan release work",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-opencode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-opencode-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-opencode-title-1"),
          role: "user",
          text: "Plan the release workflow and deployment checklist",
          attachments: [],
        },
        modelSelection: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: {
            agent: "plan",
            variant: "balanced",
          },
        },
        providerOptions: {
          opencode: {
            binaryPath: "/custom/bin/opencode",
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "opencode",
        model: "openai/gpt-5",
        options: {
          agent: "plan",
          variant: "balanced",
        },
      },
      providerOptions: {
        opencode: {
          binaryPath: "/custom/bin/opencode",
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "secret",
        },
      },
    });
  });

  it("queues a follow-up turn while the current turn is still running", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-queue"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queue-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queue-1"),
          role: "user",
          text: "queue this next",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-queue"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "queue this next",
    });
  });

  it("steers immediately for codex sessions when Cmd/Ctrl+Enter is used", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-codex"),
          role: "user",
          text: "pivot now",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "pivot now",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
  });

  it("falls back to interrupt plus priority queue for claude steering", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-steer-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-claude"),
          role: "user",
          text: "switch directions",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn.mock.calls.length).toBe(1);

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-steer-claude"),
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running"),
      payload: {
        state: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "switch directions",
    });
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fast"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("forwards codex effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-effort"),
          role: "user",
          text: "hello with codex effort",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
          options: {
            reasoningEffort: "high",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
        options: {
          reasoningEffort: "high",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
        options: {
          reasoningEffort: "high",
        },
      },
    });
  });

  it("restarts an idle Claude session immediately when thread model selection changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-bootstrap"),
          role: "user",
          text: "bootstrap claude session",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.startSession.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-1m"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: {
            contextWindow: "1m",
          },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: {
          contextWindow: "1m",
        },
      },
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "plan",
    });
  });

  it("rejects a first turn when requested provider conflicts with the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).toBeNull();
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      summary: "Provider turn start failed",
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "medium",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("restarts the provider session when runtime mode changes on the thread or turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 3);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.startSession.mock.calls[2]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "full-access",
    });
    expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("restarts without a resume cursor when the runtime mode changes", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-bootstrap"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-no-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("routes subagent interrupts through the parent provider session using the child provider thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Halley [explorer]",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child",
      providerThreadId: "child-provider-1",
    });
  });

  it("infers the parent provider session for synthetic subagent ids that are missing parent metadata", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-fallback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-parent"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Agent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-subagent-fallback"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child",
      providerThreadId: "child-provider-1",
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces stale provider user-input failures without faking user-input resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending user-input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("interrupts active subagent sessions without stopping the parent provider session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-parent-for-child-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        projectId: asProjectId("project-1"),
        title: "Agent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-subagent-for-stop"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        session: {
          threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-child-stop"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop-subagent"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:child-provider-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-child-stop",
      providerThreadId: "child-provider-1",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === "subagent:thread-1:child-provider-1",
      );
      return (
        thread?.session?.status === "interrupted" &&
        thread.session.activeTurnId === "turn-child-stop"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find(
      (entry) => entry.id === "subagent:thread-1:child-provider-1",
    );
    expect(thread?.session?.status).toBe("interrupted");
    expect(thread?.session?.activeTurnId).toBe("turn-child-stop");
  });
});
