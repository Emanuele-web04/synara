// FILE: ProviderCommandReactor.test.ts
// Purpose: Verifies provider intent orchestration, queueing, rollback, and transcript bootstrap flows.
// Layer: Orchestration integration tests
// Depends on: ProviderCommandReactorLive with in-memory provider and persistence services.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ModelSelection,
  ProviderForkThreadResult,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
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
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  StudioOutputReactor,
  type StudioOutputReactorShape,
} from "../Services/StudioOutputReactor.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly conversationRollback?: "native" | "restart-session";
    readonly checkpointStore?: Partial<CheckpointStoreShape>;
    readonly studioOutputReactor?: Partial<StudioOutputReactorShape>;
    readonly forkThreadResult?: ProviderForkThreadResult | null;
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "synara-reactor-"));
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
      const sessionModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? ((input as { modelSelection?: ModelSelection }).modelSelection ?? modelSelection)
          : modelSelection;
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
        provider: sessionModelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(sessionModelSelection.model !== undefined
          ? { model: sessionModelSelection.model }
          : {}),
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
    // Mirrors adapter behavior: the reactor consults live provider sessions
    // (status + activeTurnId) to decide whether a turn is genuinely running.
    const setRuntimeSessionTurnState = (input: {
      readonly threadId: string;
      readonly status: ProviderSession["status"];
      readonly activeTurnId?: TurnId;
    }) => {
      const threadId = ThreadId.makeUnsafe(input.threadId);
      const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
      const base: ProviderSession = runtimeSessions[index] ?? {
        provider: modelSelection.provider,
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        resumeCursor: { opaque: "resume-synthetic" },
        createdAt: now,
        updatedAt: now,
      };
      const next: ProviderSession = {
        ...base,
        status: input.status,
        ...(input.activeTurnId !== undefined ? { activeTurnId: input.activeTurnId } : {}),
      };
      if (input.activeTurnId === undefined) {
        delete (next as { activeTurnId?: TurnId }).activeTurnId;
      }
      if (index >= 0) {
        runtimeSessions[index] = next;
      } else {
        runtimeSessions.push(next);
      }
    };
    const steerTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-steer-1"),
      }),
    );
    const startReview = vi.fn<ProviderServiceShape["startReview"]>((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: asTurnId("turn-review-1"),
      }),
    );
    const forkThread = vi.fn<NonNullable<ProviderServiceShape["forkThread"]>>((forkInput) =>
      Effect.sync(() => {
        const result = input?.forkThreadResult ?? null;
        const forkModelSelection = forkInput.modelSelection ?? modelSelection;
        if (result && !runtimeSessions.some((session) => session.threadId === forkInput.threadId)) {
          runtimeSessions.push({
            provider: forkModelSelection.provider,
            status: "ready",
            runtimeMode: forkInput.runtimeMode,
            ...(forkModelSelection.model !== undefined ? { model: forkModelSelection.model } : {}),
            threadId: forkInput.threadId,
            ...(result.resumeCursor !== undefined ? { resumeCursor: result.resumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          });
        }
        return result;
      }),
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
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void);
    const checkpointStore: CheckpointStoreShape = {
      isGitRepository,
      captureCheckpoint,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint,
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
      ...input?.checkpointStore,
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
    const captureStudioOutputBaseline = vi.fn<
      StudioOutputReactorShape["captureBaselineBeforeTurn"]
    >(input?.studioOutputReactor?.captureBaselineBeforeTurn ?? (() => Effect.void));
    const cancelPendingStudioOutputBaseline = vi.fn<
      StudioOutputReactorShape["cancelPendingTurnBaseline"]
    >(input?.studioOutputReactor?.cancelPendingTurnBaseline ?? (() => Effect.void));
    const studioOutputReactor: StudioOutputReactorShape = {
      captureBaselineBeforeTurn: captureStudioOutputBaseline,
      cancelPendingTurnBaseline: cancelPendingStudioOutputBaseline,
      start: input?.studioOutputReactor?.start ?? Effect.void,
      drain: input?.studioOutputReactor?.drain ?? Effect.void,
    };

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      startReview,
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
          ...(input?.conversationRollback
            ? { conversationRollback: input.conversationRollback }
            : {}),
        }),
      rollbackConversation,
      compactThread: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(StudioOutputReactor, studioOutputReactor)),
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
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
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
      startReview,
      forkThread,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      rollbackConversation,
      isGitRepository,
      captureCheckpoint,
      restoreCheckpoint,
      stopSession,
      stopRuntimeSession,
      clearSessionResumeCursor,
      renameBranch,
      publishBranch,
      generateBranchName,
      generateThreadTitle,
      captureStudioOutputBaseline,
      cancelPendingStudioOutputBaseline,
      stateDir,
      drain,
      emitRuntimeEvent,
      setRuntimeSessionTurnState,
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

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-sidechat-second-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-sidechat"),
        message: {
          messageId: asMessageId("sidechat-second-user"),
          role: "user",
          text: "Second side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(secondInput?.input).not.toContain("<sidechat_context>");
    expect(secondInput?.input).not.toContain("<thread_context>");
    expect(secondInput?.input).not.toContain("Earlier question");
    expect(secondInput?.input).not.toContain("Earlier answer");
    expect(secondInput?.input).toContain("Second side question");
  });

  it("bootstraps Droid sidechat context after a native provider fork", async () => {
    const threadId = ThreadId.makeUnsafe("thread-native-droid-sidechat");
    const harness = await createHarness({
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "native-droid-fork" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-fork-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Native Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("native-droid-sidechat-imported-user"),
            role: "user",
            text: "Imported Droid sidechat question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("native-droid-sidechat-imported-assistant"),
            role: "assistant",
            text: "Imported Droid sidechat answer",
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
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-overlong-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("native-droid-sidechat-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "error"
      );
    });
    expect(harness.forkThread).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const failedReadModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(
      failedReadModel.threads.find((thread) => thread.id === threadId)?.session?.lastError,
    ).toContain("too long to include the sidechat context");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-native-droid-sidechat-turn-start"),
        threadId,
        message: {
          messageId: asMessageId("native-droid-sidechat-user"),
          role: "user",
          text: "Continue the native Droid sidechat",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.forkThread).toHaveBeenCalledTimes(1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Imported Droid sidechat question");
    expect(input?.input).toContain("Imported Droid sidechat answer");
    expect(input?.input).toContain("Continue the native Droid sidechat");
    expect(input?.input?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
  });

  it("preserves pending sidechat context when the first turn is an overlong provider review", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Review sidechat",
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
            messageId: asMessageId("review-sidechat-imported-user"),
            role: "user",
            text: "Context that must survive the review",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("review-sidechat-imported-assistant"),
            role: "assistant",
            text: "Prior sidechat answer",
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
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-review-start"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        message: {
          messageId: asMessageId("review-sidechat-review-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startReview.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-review-sidechat-follow-up-start"),
        threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
        message: {
          messageId: asMessageId("review-sidechat-follow-up-user"),
          role: "user",
          text: "Continue with the side question",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Context that must survive the review");
    expect(input?.input).toContain("Prior sidechat answer");
    expect(input?.input).toContain("Continue with the side question");
  });

  it("preserves full transcript bootstrap when an overlong review restarts a sidechat", async () => {
    const threadId = ThreadId.makeUnsafe("thread-restarted-droid-sidechat");
    const harness = await createHarness({
      sessionModelSwitch: "restart-session",
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "restarted-droid-sidechat" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Restarted Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("restarted-droid-sidechat-imported-user"),
            role: "user",
            text: "Retained sidechat question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("restarted-droid-sidechat-imported-assistant"),
            role: "assistant",
            text: "Retained sidechat answer",
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
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-review"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-review-user"),
          role: "user",
          text: "Review before restarting",
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startReview.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-overlong-review"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-overlong-review-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        reviewTarget: { type: "uncommittedChanges" },
        modelSelection: {
          provider: "droid",
          model: "claude-opus-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startReview.mock.calls.length === 2);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-restarted-droid-sidechat-turn"),
        threadId,
        message: {
          messageId: asMessageId("restarted-droid-sidechat-latest-user"),
          role: "user",
          text: "Continue after restarting",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<thread_context>");
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).toContain("Retained sidechat question");
    expect(input?.input).toContain("Retained sidechat answer");
    expect(input?.input).toContain("Continue after restarting");
  });

  it("blocks an overlong Droid fork turn and bootstraps its shorter retry", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const importedAt = new Date(Date.parse(now) - 1_000).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("droid-fork-user"),
            role: "user",
            text: "Retained question",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
          {
            messageId: asMessageId("droid-fork-assistant"),
            role: "assistant",
            text: "Retained answer",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-overlong-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        message: {
          messageId: asMessageId("droid-fork-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === "thread-droid-fork")?.session?.status ===
        "error"
      );
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const failedReadModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(
      failedReadModel.threads.find((thread) => thread.id === "thread-droid-fork")?.session
        ?.lastError,
    ).toContain("too long to include the transcript context");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-fork-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-droid-fork"),
        message: {
          messageId: asMessageId("droid-fork-latest-user"),
          role: "user",
          text: "Continue here",
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
    expect(input?.input).toContain("<thread_context>");
    expect(input?.input).toContain("Retained question");
    expect(input?.input).toContain("Retained answer");
    expect(input?.input).toContain("Continue here");
  });

  it("does not rebootstrap an empty Droid fork after its first native turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Empty Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-first-turn"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        message: {
          messageId: asMessageId("empty-droid-fork-first-user"),
          role: "user",
          text: "First message without prior context",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const firstInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(firstInput?.input).not.toContain("<thread_context>");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-empty-droid-fork-second-turn"),
        threadId: ThreadId.makeUnsafe("thread-empty-droid-fork"),
        message: {
          messageId: asMessageId("empty-droid-fork-second-user"),
          role: "user",
          text: "Second message continues the native session",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const secondInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(secondInput?.input).not.toContain("<thread_context>");
    expect(secondInput?.input).not.toContain("First message without prior context");
    expect(secondInput?.input).toContain("Second message continues the native session");
  });

  it("retries a pending Droid fork bootstrap on an existing session", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "droid",
          method: "session/prompt",
          detail: "simulated Droid prompt failure",
        }),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-create"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Retry Droid fork",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("retry-droid-fork-imported-user"),
            role: "user",
            text: "Retained context for retry",
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
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-failed-turn"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        message: {
          messageId: asMessageId("retry-droid-fork-failed-user"),
          role: "user",
          text: "Failed attempt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === "thread-retry-droid-fork")?.session
          ?.status === "error"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-retry-droid-fork-success-turn"),
        threadId: ThreadId.makeUnsafe("thread-retry-droid-fork"),
        message: {
          messageId: asMessageId("retry-droid-fork-success-user"),
          role: "user",
          text: "Retry now",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(retryInput?.input).toContain("<thread_context>");
    expect(retryInput?.input).toContain("Retained context for retry");
    expect(retryInput?.input).toContain("Retry now");
  });

  it("retains a Droid transcript bootstrap when the forked prompt later fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-droid-async-bootstrap-failure");
    const firstTurnId = asTurnId("turn-droid-bootstrap-failed");
    const retryTurnId = asTurnId("turn-droid-bootstrap-retry");
    const followUpTurnId = asTurnId("turn-droid-bootstrap-follow-up");
    const harness = await createHarness({
      threadModelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
      },
    });
    const now = new Date().toISOString();
    const importedAt = new Date(Date.parse(now) - 1_000).toISOString();
    harness.sendTurn
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: firstTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: followUpTurnId }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-fork"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Droid async bootstrap failure",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("droid-async-bootstrap-imported-user"),
            role: "user",
            text: "Context retained across the failed prompt",
            createdAt: importedAt,
            updatedAt: importedAt,
          },
        ],
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-first-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-first-user"),
          role: "user",
          text: "First attempt",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const firstInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(firstInput?.input).toContain("<thread_context>");

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-droid-async-bootstrap-failed"),
      provider: "droid",
      threadId,
      createdAt: new Date().toISOString(),
      turnId: firstTurnId,
      payload: {
        state: "failed",
        errorMessage: "ACP prompt failed after dispatch",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-retry-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-retry-user"),
          role: "user",
          text: "Retry after async failure",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(retryInput?.input).toContain("<thread_context>");
    expect(retryInput?.input).toContain("Context retained across the failed prompt");
    expect(retryInput?.input).toContain("Retry after async failure");

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-droid-async-bootstrap-retry-completed"),
      provider: "droid",
      threadId,
      createdAt: new Date().toISOString(),
      turnId: retryTurnId,
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-droid-async-bootstrap-follow-up-turn"),
        threadId,
        message: {
          messageId: asMessageId("droid-async-bootstrap-follow-up-user"),
          role: "user",
          text: "Continue after successful retry",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    const followUpInput = harness.sendTurn.mock.calls[2]?.[0] as { input?: string } | undefined;
    expect(followUpInput?.input).not.toContain("<thread_context>");
    expect(followUpInput?.input).toBe("Continue after successful retry");
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

  it("restarts Droid edits and bootstraps only the retained transcript", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "droid", model: "claude-opus-4-8" },
      conversationRollback: "restart-session",
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-droid-retained-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("droid-earlier-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("droid-earlier-assistant"),
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
        commandId: CommandId.makeUnsafe("cmd-droid-original-edit-turn"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("droid-edit-target"),
          role: "user",
          text: "old prompt",
          attachments: [],
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
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-droid-active-edit-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "droid",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-droid-active-edit"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("cmd-droid-edit-and-resend"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("droid-edit-target"),
        text: "edited prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.clearSessionResumeCursor.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.clearSessionResumeCursor.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    const resent = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(resent?.input).toContain("<thread_context>");
    expect(resent?.input).toContain("Earlier question");
    expect(resent?.input).toContain("Earlier answer");
    expect(resent?.input).toContain("edited prompt");
    expect(resent?.input).not.toContain("old prompt");
  });

  it("keeps queued-message edits queued while an active provider turn continues", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-edit-queued"),
    });
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

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
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

  it("waits for the message-start checkpoint before sending the provider turn", async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() =>
      Effect.promise(() => captureGate),
    );
    const harness = await createHarness({
      checkpointStore: {
        isGitRepository: vi.fn<CheckpointStoreShape["isGitRepository"]>(() => Effect.succeed(true)),
        captureCheckpoint,
      },
    });
    const now = new Date().toISOString();

    const dispatch = Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slow-checkpoint"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-checkpoint"),
          role: "user",
          text: "hello despite slow git",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => captureCheckpoint.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    releaseCapture?.();
    await dispatch;
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(captureCheckpoint.mock.calls.length).toBe(1);
    expect(captureCheckpoint.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project",
    });
    expect(captureCheckpoint.mock.calls[0]?.[0].checkpointRef).toContain("/message-start/");
  });

  it("waits for the Studio output baseline before sending the provider turn", async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureBaselineBeforeTurn = vi.fn<StudioOutputReactorShape["captureBaselineBeforeTurn"]>(
      () => Effect.promise(() => captureGate),
    );
    const harness = await createHarness({
      studioOutputReactor: { captureBaselineBeforeTurn },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slow-studio-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-studio-baseline"),
          role: "user",
          text: "create an output immediately",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => captureBaselineBeforeTurn.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.sendTurn).not.toHaveBeenCalled();

    releaseCapture?.();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(captureBaselineBeforeTurn).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-1"));
  });

  it("publishes a starting session status before the provider session is ready", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    // Gate provider init so the early status is observable while it is pending.
    let releaseStartSession: (() => void) | undefined;
    const startSessionGate = new Promise<void>((resolve) => {
      releaseStartSession = resolve;
    });
    const defaultStartSession = harness.startSession.getMockImplementation();
    if (!defaultStartSession) {
      throw new Error("Harness startSession mock has no implementation.");
    }
    harness.startSession.mockImplementationOnce((threadId: unknown, input: unknown) =>
      Effect.promise(() => startSessionGate).pipe(
        Effect.flatMap(() => defaultStartSession(threadId, input)),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-early-status"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-early-status"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    // The slow-provider window: status is already "starting" while init blocks.
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads[0]?.session?.status === "starting";
    });
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    releaseStartSession?.();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const status = readModel.threads[0]?.session?.status;
      return status !== undefined && status !== "starting";
    });
  });

  it("clears stale Claude resume state and retries the turn with transcript context", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/setModel",
          detail:
            "Claude Code returned an error result: No conversation found with session ID: b469168a-2625-4447-927f-d86d94bb7237",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-claude-stale-resume-history"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-claude-history"),
            role: "user",
            text: "Move the changelog navigation to the left.",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("assistant-message-claude-history"),
            role: "assistant",
            text: "I moved the changelog navigation into the left rail.",
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
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-stale-resume"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-stale-resume"),
          role: "user",
          text: "nice but bring it on the left.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.startSession.mock.calls.length).toBe(2);
    const retryStartInput = harness.startSession.mock.calls[1]?.[1];
    expect(retryStartInput).not.toHaveProperty("resumeCursor");

    const retrySendInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).toContain("<thread_context>");
    expect(retrySendInput.input).toContain("Move the changelog navigation to the left.");
    expect(retrySendInput.input).toContain("<latest_user_message>");
    expect(retrySendInput.input).toContain("nice but bring it on the left.");
  });

  it("marks the thread session errored when normal turn start fails", async () => {
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
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-start-fails"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
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
    expect(harness.cancelPendingStudioOutputBaseline).toHaveBeenCalledWith(
      ThreadId.makeUnsafe("thread-1"),
    );
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

  it("uses the configured text generation model for providers without native title generation", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
    });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.succeed({
        title: "Provider startup failures",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-antigravity-generated"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Summarize provider startup failures without Codex",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-antigravity-generated-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-antigravity-generated-title-1"),
          role: "user",
          text: "Summarize provider startup failures without Codex",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Summarize provider startup failures without Codex",
      modelSelection: {
        provider: "codex",
      },
    });
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Provider startup failures"
      );
    });
  });

  it("uses a local fallback title when configured text generation fails", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-antigravity"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-antigravity-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-antigravity-title-1"),
          role: "user",
          text: "Summarize provider startup failures without Codex",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Summarize provider startup failures without Codex"
      );
    });
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
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
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
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
        thread?.branch === "synara/app-startup-crash" &&
        thread.associatedWorktreeBranch === "synara/app-startup-crash" &&
        thread.associatedWorktreeRef === "synara/app-startup-crash"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toMatchObject({
      branch: "synara/app-startup-crash",
      worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreeBranch: "synara/app-startup-crash",
      associatedWorktreeRef: "synara/app-startup-crash",
    });
  });

  it("falls back to prompt-based worktree branch names when the provider cannot generate one", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-bootstrap-antigravity"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-fallback-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-fallback-rename"),
          role: "user",
          text: "Fix provider startup timeouts",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          model: "Gemini 3.5 Flash",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.renameBranch.mock.calls[0]?.[0]).toMatchObject({
      oldBranch: "synara/cb661f0d",
      newBranch: "synara/fix-provider-startup-timeouts",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.branch === "synara/fix-provider-startup-timeouts";
    });
  });

  it("renames generic OpenCode first-turn thread titles using text generation", async () => {
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
      message: "Plan the release workflow and deployment checklist",
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
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Plan release work"
      );
    });
  });

  it("queues a follow-up turn while the current turn is still running", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
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

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
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

  it("keeps the next queued turn blocked until the promoted turn settles", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const firstSendGate: {
      release: ((value: { readonly threadId: ThreadId; readonly turnId: TurnId }) => void) | null;
    } = { release: null };

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-before-promotion"),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running-double-queue"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-running-before-promotion"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.sendTurn.mockImplementationOnce(() =>
      Effect.tryPromise(
        () =>
          new Promise<{ readonly threadId: ThreadId; readonly turnId: TurnId }>((resolve) => {
            firstSendGate.release = resolve;
          }),
      ),
    );

    for (const [messageId, text] of [
      ["msg-queue-promoted-1", "first queued turn"],
      ["msg-queue-promoted-2", "second queued turn"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-${messageId}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
    }

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-promote-first"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-before-promotion"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "first queued turn",
    });

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-promoted-1"),
    });
    expect(firstSendGate.release).not.toBeNull();
    firstSendGate.release?.({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-promoted-1"),
    });
    await harness.drain();

    // A duplicate/late terminal event for the previous turn can arrive after
    // the promoted turn has fully started. It must not release that promoted
    // turn's session reservation or drain the next queued message.
    await harness.emitRuntimeEvent({
      type: "turn.aborted",
      eventId: asEventId("evt-late-turn-aborted-after-promotion-started"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running-before-promotion"),
      payload: {
        reason: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-promoted-first"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-promoted-1"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "second queued turn",
    });
  });

  it("queues a child-thread turn while the shared parent session runs and drains it on settle", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    // The child shares the parent's provider session, which is mid-turn.
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-running"),
    });
    harness.sendTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-child-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-child"),
        message: {
          messageId: asMessageId("msg-child-queued"),
          role: "user",
          text: "child follow-up",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    // A raw child-id session lookup would miss the parent's live turn and
    // dispatch immediately, overlapping the shared provider session.
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-parent-turn-completed"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-parent-running"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child"),
      input: "child follow-up",
    });
  });

  it("drains sibling child queues after a promoted child turn fails to start", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    for (const childId of ["thread-child-a", "thread-child-b"] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-${childId}-create`),
          threadId: ThreadId.makeUnsafe(childId),
          projectId: asProjectId("project-1"),
          parentThreadId: ThreadId.makeUnsafe("thread-1"),
          title: childId,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-running-siblings"),
    });
    harness.sendTurn.mockClear();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "child start failed",
        }),
      ),
    );

    for (const [threadId, messageId, text] of [
      ["thread-child-a", "msg-child-a", "first child follow-up"],
      ["thread-child-b", "msg-child-b", "second child follow-up"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${messageId}`),
          threadId: ThreadId.makeUnsafe(threadId),
          message: {
            messageId: asMessageId(messageId),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
    }

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-parent-turn-completed-sibling-drain"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-parent-running-siblings"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child-b"),
      input: "second child follow-up",
    });
  });

  it("promotes a queued turn immediately when the provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection still says the thread is running (stale), but the provider
    // turn has already settled: its terminal event was consumed before this
    // message was queued, so no future drain trigger will ever arrive.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stale-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-already-settled"),
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
        commandId: CommandId.makeUnsafe("cmd-turn-queue-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queue-stale"),
          role: "user",
          text: "recover me",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    // No turn.completed/turn.aborted is emitted: the recovery drain alone
    // must promote the queued message.
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "recover me",
    });
  });

  it("re-queues a direct turn start that races a live provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // The provider is mid-turn but the projection has no running session yet
    // (e.g. the gap between a steer interrupt and the steered turn's start):
    // the decider dispatches directly instead of queueing.
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-live-race"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-turn-race"),
          role: "user",
          text: "wait your turn",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-race"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-live-race"),
      payload: {
        state: "completed",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "wait your turn",
    });
  });

  it("steers immediately for codex sessions when Cmd/Ctrl+Enter is used", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
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

  it("dispatches a codex steer as a queued turn when the live provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection lags: it still says running, but the provider runtime has no
    // live turn. The steer must not ride the native codex steer path (which
    // would skip the turn-start checkpoint) — it dispatches as a normal turn.
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stale-steer-codex"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-settled"),
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
        commandId: CommandId.makeUnsafe("cmd-turn-steer-codex-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-codex-stale"),
          role: "user",
          text: "steer but nothing is running",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "steer but nothing is running",
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

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
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

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
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

  it("restarts an idle Claude session only for spawn-fixed model selection changes", async () => {
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
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
      },
    });
    harness.startSession.mockClear();

    // Context-window changes switch in-session via setModel on the next turn.
    // Restarting would resume via --resume and replay the whole conversation
    // as uncached input tokens.
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

    // Effort is fixed at subprocess spawn, so an effort change still restarts.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: {
            effort: "max",
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
          effort: "max",
        },
      },
    });
  });

  it("restarts a directly started Claude session when spawn-fixed options change", async () => {
    const initialSelection: ModelSelection = {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    };
    const harness = await createHarness({ threadModelSelection: initialSelection });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    // Mirrors native import: ProviderService owns the runtime start directly,
    // while the reactor learns the original selection from thread.created.
    await harness.drain();
    const importedSession = await Effect.runPromise(
      harness.startSession(threadId, {
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        modelSelection: initialSelection,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-direct-claude-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: importedSession.updatedAt,
        },
        createdAt: importedSession.updatedAt,
      }),
    );
    harness.startSession.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-direct-claude-effort-update"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { effort: "max" },
      },
    });
  });

  it("keeps the applied Claude spawn profile while metadata changes mid-turn", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-active-selection-change");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-active-selection-bootstrap"),
        threadId,
        message: {
          messageId: asMessageId("user-message-active-selection-bootstrap"),
          role: "user",
          text: "bootstrap",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    harness.startSession.mockClear();

    harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: turnId });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-active-selection-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-active-selection-effort"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-active-selection-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    // The context-only edit is compared with the profile that is actually live,
    // so the pending effort change still forces exactly one replacement.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-active-selection-context"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { effort: "max", contextWindow: "1m" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { effort: "max", contextWindow: "1m" },
      },
    });
  });

  it("seeds imported Droid selection before handling idle metadata updates", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "medium" },
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-imported-droid"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "droid",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-droid-same-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
          options: { reasoningEffort: "medium" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-droid-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
          options: { reasoningEffort: "high" },
        },
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-synthetic" },
      modelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "high" },
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

  it("adopts the requested provider on a first turn before binding a session", async () => {
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.modelSelection).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
    });
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
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

  it("forwards approval responses before the session projection is visible", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-early"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-early"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-early",
      decision: "accept",
    });
  });

  it("forwards user-input responses before the session projection is visible", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-early"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-early"),
        answers: {
          input: "continue",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-early",
      answers: {
        input: "continue",
      },
    });
  });

  it("does not forward approval responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
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
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-stopped"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.approval.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToRequest).not.toHaveBeenCalled();
  });

  it("does not forward user-input responses when the projected session is stopped", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
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
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-stopped"),
        answers: {
          input: "continue",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        ) ?? false
      );
    });
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
  });

  it("preserves array and mixed answer shapes through the runtime path", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-multi"),
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
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-multi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-multi"),
        answers: {
          single: "TypeScript",
          features: ["CLI scaffolding", "Type checking"],
          rating: "Solid",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-multi",
      answers: {
        single: "TypeScript",
        features: ["CLI scaffolding", "Type checking"],
        rating: "Solid",
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

    await waitFor(async () => {
      if (harness.stopSession.mock.calls.length !== 1) return false;
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.session?.status === "stopped";
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("does not restore pending sidechat context after an explicit session stop", async () => {
    const threadId = ThreadId.makeUnsafe("thread-stopped-droid-sidechat");
    const harness = await createHarness({
      forkThreadResult: {
        threadId,
        resumeCursor: { sessionId: "stopped-droid-sidechat" },
      },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-create"),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Stopped Droid sidechat",
        modelSelection: {
          provider: "droid",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [
          {
            messageId: asMessageId("stopped-droid-sidechat-imported-user"),
            role: "user",
            text: "Context cleared by stop",
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
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-overlong"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-overlong-user"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 100),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "error"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-stop"),
        threadId,
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        harness.stopSession.mock.calls.length === 1 &&
        readModel.threads.find((thread) => thread.id === threadId)?.session?.status === "stopped"
      );
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-stopped-droid-sidechat-fresh-turn"),
        threadId,
        message: {
          messageId: asMessageId("stopped-droid-sidechat-fresh-user"),
          role: "user",
          text: "Start fresh after stop",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).not.toContain("<thread_context>");
    expect(input?.input).not.toContain("Context cleared by stop");
    expect(input?.input).toContain("Start fresh after stop");
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
