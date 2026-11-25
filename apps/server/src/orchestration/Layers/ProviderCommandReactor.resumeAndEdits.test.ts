// FILE: ProviderCommandReactor.resumeAndEdits.test.ts
// Purpose: ProviderCommandReactor cases for resume and goal continuation, Droid forks, interrupt escalation, typed skills, and message edits.
// Layer: Orchestration integration tests
// Depends on: providerCommandReactorHarness (ProviderCommandReactorLive with in-memory provider
//             and persistence services).
// Note: one contiguous slice of the former single ProviderCommandReactor.test.ts, in its
//       original order, so CI can run the slices on separate workers.

import { RemoteSessionRegistryLive } from "../../remoteSessions/sessionRegistry";
import fs from "node:fs";
import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { HttpRouter } from "effect/unstable/http";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ChatImageAttachment, ProviderKind, ProviderRuntimeEvent } from "@synara/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { SIDECHAT_INACTIVITY_EXPIRY_MS } from "@synara/shared/sidechatExpiry";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, ServiceMap, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend.ts";
import { ServerConfig } from "../../config.ts";
import { GitCommandError } from "../../git/Errors.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { resolveProviderAttachmentPath } from "../../provider/providerAttachmentPaths.ts";
import { loadProviderPromptImageBlocks } from "../../provider/promptAttachments.ts";
import { binaryUploadEffectRouteLayer, attachmentsEffectRouteLayer } from "../../http.ts";
import { AuthCoreLive, AuthControlPlaneLive } from "../../auth/Layers/AuthControlPlane.ts";
import { ServerAuthLive } from "../../auth/Layers/ServerAuth.ts";
import { ServerAuthPolicyLive } from "../../auth/Layers/ServerAuthPolicy.ts";
import { SessionCredentialService } from "../../auth/Services/SessionCredentialService.ts";
import {
  attachmentPrincipalForSession,
  bindRemoteAttachmentSession,
} from "../../managedAttachmentPrincipal.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import {
  checkpointRefForThreadTurn,
  isManagedCheckpointRefForThread,
} from "../../checkpointing/Utils.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  asProjectId,
  asApprovalRequestId,
  asEventId,
  asMessageId,
  asTurnId,
  waitFor,
  createRetainingRestartProviderServiceLayer,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("ProviderCommandReactor", () => {
  const {
    runtimes,
    scopes,
    createdBaseDirs,
    createHarness,
    seedRollbackTarget,
    readHarnessThread,
    dispatchHarnessUserTurn,
    setHarnessSession,
    emitHarnessTurnTerminal,
    seedQueuedTurnBehindLiveTurn,
  } = useProviderCommandReactorHarness();

  it("keeps thread mention context within the provider input limit", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const messageText = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-max-input-with-thread-mention"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("max-input-with-thread-mention"),
          role: "user",
          text: messageText,
          attachments: [],
          mentions: [{ name: "Current thread", path: "thread://thread-1" }],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as
      | { input?: string; mentions?: ReadonlyArray<unknown> }
      | undefined;
    expect(input?.input).toBe(messageText);
    expect(input?.input?.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(input?.mentions).toBeUndefined();
  });

  it("rejects a provider-max input that cannot also fit the persistent thread goal", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-max-input-goal-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Preserve the full objective",
        goalStartBehavior: "defer",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-max-input-with-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("max-input-with-goal"),
          role: "user",
          text: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness))?.session?.lastError).toContain(
      "too long to include the persistent thread goal",
    );
  });

  it.each([
    { startBehavior: undefined, objective: "Finish the complete implementation", visible: false },
    { startBehavior: "start-with-message" as const, objective: "clear", visible: true },
    {
      startBehavior: "start-with-message" as const,
      objective: "-- keep this literal",
      visible: true,
    },
  ])(
    "starts an idle active goal with one continuation turn ($startBehavior)",
    async ({ startBehavior, objective, visible }) => {
      const harness = await createHarness();
      const command = {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-autostart"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: objective,
        ...(startBehavior ? { goalStartBehavior: startBehavior } : {}),
      } as const;
      await Effect.runPromise(harness.engine.dispatch(command));

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      await Effect.runPromise(harness.engine.dispatch(command));
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const providerInput = harness.sendTurn.mock.calls[0]?.[0].input;
      expect(providerInput).toContain("<synara_goal>");
      expect(providerInput).toContain(objective);
      expect(providerInput).toContain("Continue working toward the active thread goal");
      const messages = (await readHarnessThread(harness))?.messages;
      if (visible) {
        expect(messages).toMatchObject([
          { role: "user", text: `/goal -- ${objective}`, turnId: "turn-1" },
        ]);
        expect(messages).toHaveLength(1);
      } else {
        expect(messages).toEqual([]);
      }
    },
  );

  const sendUserTurn = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    id: string,
    text: string,
    options?: {
      readonly sourceProposedPlan?: { readonly threadId: ThreadId; readonly planId: string };
    },
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        runtimeMode: "approval-required",
        interactionMode: "default",
        commandId: CommandId.makeUnsafe(`cmd-send-${id}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: { messageId: MessageId.makeUnsafe(id), role: "user", text, attachments: [] },
        enableComputerControl: false,
        computerControlGeneration: 0,
        ...(options?.sourceProposedPlan ? { sourceProposedPlan: options.sourceProposedPlan } : {}),
        createdAt: new Date().toISOString(),
      }),
    );
  const resumeThread = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    id: string,
    options?: { readonly continuationPrompt?: string; readonly computerControlGeneration?: number },
  ) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.resume",
        commandId: CommandId.makeUnsafe(id),
        threadId: ThreadId.makeUnsafe("thread-1"),
        ...(options?.continuationPrompt ? { continuationPrompt: options.continuationPrompt } : {}),
        ...(options?.computerControlGeneration !== undefined
          ? { computerControlGeneration: options.computerControlGeneration }
          : {}),
        createdAt: new Date().toISOString(),
      }),
    );
  // A refused send quarantines the thread; Unblock abandons that delivery and
  // never retries it, which leaves exactly the message Resume should resend.
  const failThenUnblockSend = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    send: () => Promise<unknown>,
  ) => {
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "Provider refused the turn.",
        }),
      ),
    );
    await send();
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    await harness.drain();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const blocker = (
      await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId,
        }),
      )
    ).pipe(Option.getOrThrow);
    await Effect.runPromise(
      harness.reactor.reconcileDelivery({
        eventSequence: blocker.eventSequence,
        threadId,
        expectedState: blocker.state === "dead" ? "dead" : "uncertain",
        outcome: "abandon",
        reconciledBy: "local-loopback:local-loopback",
        note: "Unblocked from the thread error banner.",
      }),
    );
    await harness.drain();
  };
  // The turn requests the stored message has had, oldest first.
  const turnRequestsFor = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    messageId: string,
  ) =>
    (
      await Effect.runPromise(
        harness.engine
          .readThreadEventsThrough("thread-1", 0, Number.MAX_SAFE_INTEGER, [
            "thread.turn-start-requested",
          ])
          .pipe(Stream.runCollect),
      )
    ).flatMap((event) =>
      event.type === "thread.turn-start-requested" && event.payload.messageId === messageId
        ? [event.payload]
        : [],
    );
  // The provider accepted turn-1 and ran it; it then stopped (Stop, quit or
  // restart) or finished on its own.
  const runThenSettleTurn = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    id: string,
    settled: "interrupted" | "ready" = "interrupted",
  ) => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    for (const [status, activeTurnId] of [
      ["running", asTurnId("turn-1")],
      [settled, null],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`${id}-${status}`),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        }),
      );
    }
    harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.latestTurn?.state ===
        (settled === "ready" ? "completed" : "interrupted"),
    );
  };
  const userMessages = async (harness: Awaited<ReturnType<typeof createHarness>>) =>
    ((await readHarnessThread(harness))?.messages ?? []).filter(
      (message) => message.role === "user",
    );

  it("resends a request that never reached the provider without adding a chat message", async () => {
    const harness = await createHarness();
    await failThenUnblockSend(harness, () =>
      sendUserTurn(harness, "resume-unsent", "Refactor the settings page"),
    );
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    // Unblocked and idle: the composer offers Resume for the unsent message.
    expect((await readHarnessThread(harness))?.session).toMatchObject({
      status: "stopped",
      lastError: null,
    });

    await resumeThread(harness, "cmd-turn-resume-unsent");
    await harness.drain();
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("Refactor the settings page");
    expect(harness.sendTurn.mock.calls[1]?.[0].input).not.toContain(
      "Continue the interrupted task",
    );
    expect((await userMessages(harness)).map((message) => message.id)).toEqual(["resume-unsent"]);
  });

  it("keeps the plan a resent message implements", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe("cmd-resume-plan"),
        threadId,
        proposedPlan: {
          id: "plan-resume",
          turnId: null,
          planMarkdown: "1. Refactor the settings page",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    const sourceProposedPlan = { threadId, planId: "plan-resume" };
    await failThenUnblockSend(harness, () =>
      sendUserTurn(harness, "resume-plan-message", "Implement the plan", { sourceProposedPlan }),
    );

    await resumeThread(harness, "cmd-turn-resume-plan");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const requests = await turnRequestsFor(harness, "resume-plan-message");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ sourceProposedPlan });
  });

  it.each([
    ["restores /computer access with the resuming person's consent", 0, true],
    ["resends without computer access when nobody granted it", undefined, false],
  ] as const)("%s", async (_case, consentGeneration, computerAccess) => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const harness = await createHarness({
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
    });
    try {
      await failThenUnblockSend(harness, () =>
        sendUserTurn(harness, "resume-computer-message", "/computer-use open Calculator"),
      );
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(true);

      await resumeThread(
        harness,
        "cmd-turn-resume-computer",
        consentGeneration !== undefined ? { computerControlGeneration: consentGeneration } : {},
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await harness.drain();

      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("open Calculator");
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(
        computerAccess,
      );
      const requests = await turnRequestsFor(harness, "resume-computer-message");
      expect(requests.at(-1)?.computerControlMode).toBe(computerAccess ? "request" : "off");
    } finally {
      await manager.dispose();
    }
  });

  it("continues an interrupted turn with a provider-only prompt", async () => {
    const harness = await createHarness();
    await sendUserTurn(harness, "resume-delivered", "Refactor the settings page");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    await runThenSettleTurn(harness, "cmd-resume-interrupt-session");

    await resumeThread(harness, "cmd-resume-delivered");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const input = harness.sendTurn.mock.calls[1]?.[0].input;
    expect(input).toContain("Continue the interrupted task");
    expect(input).not.toContain("Refactor the settings page");
    expect((await userMessages(harness)).map((message) => message.id)).toEqual([
      "resume-delivered",
    ]);
  });

  it("quarantines a resume whose provider acknowledgement was lost", async () => {
    const harness = await createHarness();
    await sendUserTurn(harness, "resume-before-ack-loss", "Refactor the settings page");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    await runThenSettleTurn(harness, "cmd-resume-before-ack-loss");

    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "Transport closed while awaiting turn acceptance.",
        }),
      ),
    );
    const resume = await resumeThread(harness, "cmd-resume-without-ack");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: resume.sequence,
      }),
    );
    expect(Option.getOrThrow(delivery)).toMatchObject({ state: "uncertain", attemptCount: 1 });
    const restarted = await harness.restartReactor();
    await restarted.start();
    await resumeThread(harness, "cmd-second-resume-without-ack").catch(() => undefined);
    await Effect.runPromise(restarted.reactor.drain);
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(await userMessages(harness)).toHaveLength(1);
  });

  it("sends the recorded quit prompt when the app resumes a chat", async () => {
    const harness = await createHarness();
    await sendUserTurn(harness, "resume-quit", "Refactor the settings page");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    await runThenSettleTurn(harness, "cmd-resume-quit-session");

    await resumeThread(harness, "cmd-resume-quit", {
      continuationPrompt: "Synara was closed. Continue where you left off.",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain(
      "Synara was closed. Continue where you left off.",
    );
    expect(await userMessages(harness)).toHaveLength(1);
  });

  it("does nothing when there is nothing to resume", async () => {
    const harness = await createHarness();
    await sendUserTurn(harness, "resume-settled", "Refactor the settings page");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    await runThenSettleTurn(harness, "cmd-resume-settled-session", "ready");

    await resumeThread(harness, "cmd-resume-settled").catch(() => undefined);
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("pauses a failed visible first goal turn and does not recover it until resumed", async () => {
    const harness = await createHarness();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "Provider refused the first goal turn.",
        }),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-visible-goal-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Finish the complete implementation",
        goalStartBehavior: "start-with-message",
      }),
    );
    await waitFor(async () => (await readHarnessThread(harness))?.goalPausedAt != null);
    await harness.drain();
    const failedThread = (await readHarnessThread(harness))!;
    expect(failedThread.messages).toHaveLength(1);
    expect(failedThread.session?.status).toBe("error");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-visible-goal-startup-recovery"),
        threadId: failedThread.id,
        goalStartedAt: failedThread.goalStartedAt!,
        trigger: "startup-recovery",
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-visible-goal-resume"),
        threadId: failedThread.id,
        goalPaused: false,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();
    expect((await readHarnessThread(harness))?.messages).toHaveLength(1);
  });

  it("recovers an active idle goal when the reactor restarts", async () => {
    const harness = await createHarness({ startReactor: false });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-before-reactor-restart"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Resume after Synara restarts",
        goalStartBehavior: "defer",
      }),
    );
    await harness.startReactor();

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain(
      "Continue working toward the active thread goal",
    );
  });

  it("does not replay or recover goal continuations for an expired side chat", async () => {
    const harness = await createHarness({ startReactor: false });
    const sidechatId = ThreadId.makeUnsafe("thread-expired-goal-sidechat");
    const createdAt = new Date(Date.now() - SIDECHAT_INACTIVITY_EXPIRY_MS - 1_000).toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-create-expired-goal-sidechat"),
        threadId: sidechatId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        sidechatSourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Expired goal sidechat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-before-sidechat-expiry"),
        threadId: sidechatId,
        goal: "This goal must not resume",
        goalStartBehavior: "defer",
      }),
    );
    const sidechatBeforeExpiry = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads.find((thread) => thread.id === sidechatId);
    expect(sidechatBeforeExpiry?.goalStartedAt).toBeTruthy();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-persist-goal-before-sidechat-expiry"),
        threadId: sidechatId,
        goalStartedAt: sidechatBeforeExpiry?.goalStartedAt ?? null,
        trigger: "turn-completed",
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.sidechat.expire",
        commandId: CommandId.makeUnsafe("cmd-expire-goal-sidechat"),
        threadId: sidechatId,
        expectedLastActivityAt:
          sidechatBeforeExpiry?.sidechatLastActivityAt ??
          sidechatBeforeExpiry?.createdAt ??
          createdAt,
        expiredAt: new Date().toISOString(),
      }),
    );

    await harness.startReactor();
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("does not replay a persisted turn-start intent after its side chat expires", async () => {
    const harness = await createHarness({ startReactor: false });
    const sourceThreadId = ThreadId.makeUnsafe("thread-1");
    const sidechatId = ThreadId.makeUnsafe("thread-expired-turn-start-sidechat");
    const messageId = asMessageId("message-expired-turn-start-sidechat");
    const commandId = CommandId.makeUnsafe("cmd-persist-expired-turn-start-sidechat");
    const messageEventId = asEventId("evt-message-expired-turn-start-sidechat");
    const createdAt = new Date(Date.now() - SIDECHAT_INACTIVITY_EXPIRY_MS - 1_000).toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe("cmd-create-expired-turn-start-sidechat"),
        threadId: sidechatId,
        sourceThreadId,
        sidechatSourceThreadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Expired turn start sidechat",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: [],
        createdAt,
      }),
    );
    const sidechatBeforeExpiry = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads.find((thread) => thread.id === sidechatId);
    await harness.persistWithoutLivePublication([
      {
        eventId: messageEventId,
        aggregateKind: "thread",
        aggregateId: sidechatId,
        occurredAt: createdAt,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: sidechatId,
          messageId,
          role: "user",
          text: "Do not replay after expiry",
          dispatchMode: "queue",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt,
          updatedAt: createdAt,
        },
      },
      {
        eventId: asEventId("evt-turn-start-expired-sidechat"),
        aggregateKind: "thread",
        aggregateId: sidechatId,
        occurredAt: createdAt,
        commandId,
        causationEventId: messageEventId,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-start-requested",
        payload: {
          threadId: sidechatId,
          messageId,
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        },
      },
    ]);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.sidechat.expire",
        commandId: CommandId.makeUnsafe("cmd-expire-turn-start-sidechat"),
        threadId: sidechatId,
        expectedLastActivityAt:
          sidechatBeforeExpiry?.sidechatLastActivityAt ??
          sidechatBeforeExpiry?.createdAt ??
          createdAt,
        expiredAt: new Date().toISOString(),
      }),
    );

    await harness.startReactor();
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("ignores a stale continuation request after the goal is cleared", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-stale-goal-continuation"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goalStartedAt: null,
        trigger: "turn-completed",
        createdAt: new Date().toISOString(),
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("waits for plan mode to end before continuing an active goal", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-plan-before-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-in-plan-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Implement the approved plan",
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-default-after-plan-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "default",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain(
      "Continue working toward the active thread goal",
    );
  });

  it("does not continue an active goal when toggling between Default and Debug", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-before-debug-toggle"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Keep this goal idle",
        goalStartBehavior: "defer",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-debug-with-active-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "debug",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-default-after-debug-with-active-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("does not continue an active goal for a wording-only edit", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-before-wording-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Finish the implementation",
        goalStartBehavior: "defer",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-wording-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Finish the implementation and tests",
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("resumes a paused idle goal immediately", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-paused-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Resume the full objective",
        goalStartBehavior: "defer",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-paused"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goalPaused: true,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-edited-while-paused"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Resume the edited objective",
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-resumed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goalPaused: false,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain(
      "Continue working toward the active thread goal",
    );
  });

  it("promotes queued user work before an automatic goal continuation", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-goal-queue-priority"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Finish after handling user input",
        goalStartBehavior: "defer",
      }),
    );
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-before-goal-continuation"),
      messageId: asMessageId("msg-user-before-goal-continuation"),
      text: "User follow-up wins",
    });
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt;
    expect(goalStartedAt).toBeTruthy();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-goal-continue-after-user-queue"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goalStartedAt: goalStartedAt!,
        trigger: "turn-completed",
        sourceTurnId: asTurnId("turn-before-goal-continuation"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: expect.stringContaining("User follow-up wins"),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0].input).not.toContain(
      "Continue working toward the active thread goal",
    );
  });

  it.each([false, true])(
    "retries a goal continuation after a pending interaction clears (visible first turn: %s)",
    async (visible) => {
      const harness = await createHarness({ startReactor: false });
      const now = new Date().toISOString();
      const requestId = asApprovalRequestId("approval-before-goal-continuation");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-goal-before-pending-approval"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          goal: "Continue after the approval settles",
          goalStartBehavior: visible ? "start-with-message" : "defer",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-pending-approval-before-goal"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe("activity-pending-approval-before-goal"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId,
              requestKind: "command",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );
      const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt;
      expect(goalStartedAt).toBeTruthy();
      if (!visible)
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("cmd-goal-blocked-by-approval"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            goalStartedAt: goalStartedAt!,
            trigger: "startup-recovery",
            createdAt: now,
          }),
        );
      await harness.startReactor();

      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-interrupted-session-before-goal-retry"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "interrupted",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.pendingInteractionRepository.deleteByIdentity({
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionKind: "approval",
          requestId,
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain(
        "Continue working toward the active thread goal",
      );
      await harness.drain();
      if (visible) {
        expect((await readHarnessThread(harness))?.messages).toMatchObject([
          { text: "/goal Continue after the approval settles", turnId: "turn-1" },
        ]);
      }
    },
  );

  it.each([false, true])(
    "interrupts a continuation that races a user stop (visible first turn: %s)",
    async (visible) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      let releaseSend!: (result: { readonly threadId: ThreadId; readonly turnId: TurnId }) => void;
      const sendGate = new Promise<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(
        (resolve) => {
          releaseSend = resolve;
        },
      );
      harness.sendTurn.mockImplementationOnce(() => Effect.promise(() => sendGate));

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-goal-before-stop-race"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          goal: "Stop this continuation",
          goalStartBehavior: visible ? "start-with-message" : "defer",
        }),
      );
      const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt;
      expect(goalStartedAt).toBeTruthy();
      if (!visible)
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("cmd-goal-continuation-before-stop"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            goalStartedAt: goalStartedAt!,
            trigger: "turn-completed",
            createdAt: now,
          }),
        );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-stop-racing-goal-continuation"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("turn-before-goal-continuation"),
          createdAt: now,
        }),
      );
      releaseSend({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-goal-continuation-after-stop"),
      });

      await waitFor(() => harness.interruptTurn.mock.calls.length >= 1);
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-goal-continuation-after-stop"),
      });
      expect((await readHarnessThread(harness))?.goalPausedAt).toBeTruthy();
    },
  );

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

    await dispatchHarnessUserTurn(harness, {
      messageId: "review-sidechat-follow-up-user",
      text: "Continue with the side question",
      createdAt: now,
      threadId: ThreadId.makeUnsafe("thread-review-sidechat"),
      commandId: "cmd-review-sidechat-follow-up-start",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<sidechat_context>");
    expect(input?.input).toContain("Context that must survive the review");
    expect(input?.input).toContain("Prior sidechat answer");
    expect(input?.input).toContain("Continue with the side question");
  });

  it("refuses an old accepted native-review image without starting a provider or blocking later sends", async () => {
    const harness = await createHarness({
      startReactor: false,
      gitWritingModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const commandId = CommandId.makeUnsafe("legacy-review-image-command");
    const messageId = asMessageId("legacy-review-image-message");
    const image = {
      type: "image" as const,
      id: "att_v2_adaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "legacy-review.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("legacy-review-worktree"),
        threadId,
        title: "New thread",
        envMode: "worktree",
        branch: "synara/deadbeef",
        worktreePath: "/tmp/provider-project/.worktrees/deadbeef",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/deadbeef",
        associatedWorktreeBranch: "synara/deadbeef",
        associatedWorktreeRef: "synara/deadbeef",
      }),
    );
    const attachmentPath = await harness.stageAttachment(image);
    const accepted = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId,
        message: {
          messageId,
          role: "user",
          text: "Review using this screenshot",
          attachments: [image],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: new Date().toISOString(),
      }),
    );
    // Represent a durable review accepted by an older host, before the new admission guard.
    await Effect.runPromise(harness.sql`UPDATE orchestration_events
      SET payload_json = json_set(payload_json, '$.reviewTarget', json('{"type":"uncommittedChanges"}'))
      WHERE command_id = ${commandId} AND event_type = 'thread.turn-start-requested'`);
    await harness.startReactor();
    await harness.drain();
    expect(harness.startReview).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.latestTurn).toBeNull();
    expect(thread?.session?.lastError).toContain("Native code reviews do not support attachments");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("Native code reviews do not support attachments"),
      },
    });
    expect(thread?.messages.find((message) => message.id === messageId)?.attachments).toEqual([
      image,
    ]);
    expect(fs.readFileSync(attachmentPath)).toEqual(Buffer.alloc(4));
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: accepted.sequence,
      }),
    );
    expect(Option.getOrThrow(delivery).state).toBe("succeeded");
    expect(Option.getOrThrow(delivery).attemptCount).toBe(1);
    const blocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        threadId,
      }),
    );
    expect(Option.isNone(blocker)).toBe(true);
    await dispatchHarnessUserTurn(harness, {
      messageId: "after-rejected-review",
      text: "Continue normally",
      createdAt: new Date().toISOString(),
    });
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.startReview).not.toHaveBeenCalled();
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

    await dispatchHarnessUserTurn(harness, {
      messageId: "restarted-droid-sidechat-latest-user",
      text: "Continue after restarting",
      createdAt: now,
      threadId,
      commandId: "cmd-restarted-droid-sidechat-turn",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(input?.input).toContain("<thread_context>");
    expect(input?.input).not.toContain("<sidechat_context>");
    expect(input?.input).toContain("Retained sidechat question");
    expect(input?.input).toContain("Retained sidechat answer");
    expect(input?.input).toContain("Continue after restarting");
  });

  const forkDroidThread = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    imported: ReadonlyArray<readonly ["user" | "assistant", string]>,
  ) => {
    const now = Date.now();
    const importedAt = new Date(now - 1_000).toISOString();
    return Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.fork.create",
        commandId: CommandId.makeUnsafe(`cmd-${threadId}-fork-create`),
        threadId,
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Droid fork",
        modelSelection: { provider: "droid", model: "claude-sonnet-4-6" },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        envMode: "local",
        branch: null,
        worktreePath: null,
        importedMessages: imported.map(([role, text], index) => ({
          messageId: asMessageId(`${threadId}-imported-${index}`),
          role,
          text,
          createdAt: importedAt,
          updatedAt: importedAt,
        })),
        createdAt: new Date(now).toISOString(),
      }),
    );
  };
  const sendOnDroidFork = (
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    messageId: string,
    text: string,
  ) =>
    dispatchHarnessUserTurn(harness, {
      threadId,
      messageId,
      text,
      createdAt: new Date().toISOString(),
    });
  const sentInput = (harness: Awaited<ReturnType<typeof createHarness>>, index: number) =>
    (harness.sendTurn.mock.calls[index]?.[0] as { input?: string } | undefined)?.input;

  it("blocks an overlong Droid fork turn and bootstraps its shorter retry", async () => {
    const harness = await createHarness();
    const forkId = ThreadId.makeUnsafe("thread-droid-fork");
    await forkDroidThread(harness, forkId, [
      ["user", "Retained question"],
      ["assistant", "Retained answer"],
    ]);

    await sendOnDroidFork(
      harness,
      forkId,
      "droid-fork-overlong-user",
      "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
    );
    await waitFor(
      async () => (await readHarnessThread(harness, forkId))?.session?.status === "error",
    );
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness, forkId))?.session?.lastError).toContain(
      "too long to include the transcript context",
    );

    await sendOnDroidFork(harness, forkId, "droid-fork-latest-user", "Continue here");
    await waitFor(() => harness.forkThread.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const input = sentInput(harness, 0);
    expect(input).toContain("<thread_context>");
    expect(input).toContain("Retained question");
    expect(input).toContain("Retained answer");
    expect(input).toContain("Continue here");
  });

  it("does not rebootstrap an empty Droid fork after its first native turn", async () => {
    const harness = await createHarness();
    const forkId = ThreadId.makeUnsafe("thread-empty-droid-fork");
    await forkDroidThread(harness, forkId, []);

    await sendOnDroidFork(
      harness,
      forkId,
      "empty-droid-fork-first-user",
      "First message without prior context",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(sentInput(harness, 0)).not.toContain("<thread_context>");
    await emitHarnessTurnTerminal(harness, {
      eventId: "empty-droid-fork-first-completed",
      provider: "droid",
      type: "completed",
      threadId: forkId,
    });
    await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);

    await sendOnDroidFork(
      harness,
      forkId,
      "empty-droid-fork-second-user",
      "Second message continues the native session",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(sentInput(harness, 1)).not.toContain("<thread_context>");
    expect(sentInput(harness, 1)).not.toContain("First message without prior context");
    expect(sentInput(harness, 1)).toContain("Second message continues the native session");
  });

  it("retries a pending Droid fork bootstrap on an existing session", async () => {
    const harness = await createHarness();
    const forkId = ThreadId.makeUnsafe("thread-retry-droid-fork");
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "droid",
          operation: "session/prompt",
          issue: "simulated Droid prompt preflight failure",
        }),
      ),
    );
    await forkDroidThread(harness, forkId, [["user", "Retained context for retry"]]);

    await sendOnDroidFork(harness, forkId, "retry-droid-fork-failed-user", "Failed attempt");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(
      async () => (await readHarnessThread(harness, forkId))?.session?.status === "error",
    );

    await sendOnDroidFork(harness, forkId, "retry-droid-fork-success-user", "Retry now");
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(sentInput(harness, 1)).toContain("<thread_context>");
    expect(sentInput(harness, 1)).toContain("Retained context for retry");
    expect(sentInput(harness, 1)).toContain("Retry now");
  });

  it("retains a Droid transcript bootstrap when the forked prompt later fails", async () => {
    const threadId = ThreadId.makeUnsafe("thread-droid-async-bootstrap-failure");
    const firstTurnId = asTurnId("turn-droid-bootstrap-failed");
    const retryTurnId = asTurnId("turn-droid-bootstrap-retry");
    const followUpTurnId = asTurnId("turn-droid-bootstrap-follow-up");
    const harness = await createHarness({
      threadModelSelection: { provider: "droid", model: "claude-sonnet-4-6" },
    });
    harness.sendTurn
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: firstTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryTurnId }))
      .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: followUpTurnId }));
    await forkDroidThread(harness, threadId, [
      ["user", "Context retained across the failed prompt"],
    ]);

    await sendOnDroidFork(harness, threadId, "droid-async-bootstrap-first-user", "First attempt");
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(sentInput(harness, 0)).toContain("<thread_context>");

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

    await sendOnDroidFork(
      harness,
      threadId,
      "droid-async-bootstrap-retry-user",
      "Retry after async failure",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(sentInput(harness, 1)).toContain("<thread_context>");
    expect(sentInput(harness, 1)).toContain("Context retained across the failed prompt");
    expect(sentInput(harness, 1)).toContain("Retry after async failure");

    await emitHarnessTurnTerminal(harness, {
      eventId: "evt-droid-async-bootstrap-retry-completed",
      provider: "droid",
      type: "completed",
      threadId,
      turnId: retryTurnId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await sendOnDroidFork(
      harness,
      threadId,
      "droid-async-bootstrap-follow-up-user",
      "Continue after successful retry",
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(sentInput(harness, 2)).toBe("Continue after successful retry");
  });

  it("preserves the provider resume cursor when interrupt escalation stops the runtime", async () => {
    const harness = await createHarness({
      interruptTurn: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/interrupt",
            detail: "connection closed after request write",
          }),
        ),
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-interrupt-escalation",
      text: "Start a turn that cannot be interrupted",
      createdAt: now,
      threadId,
      commandId: "cmd-interrupt-escalation-turn",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.setRuntimeSessionTurnState({
      threadId,
      status: "running",
      activeTurnId: asTurnId("turn-interrupt-escalation"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-interrupt-escalation"),
        threadId,
        turnId: asTurnId("turn-interrupt-escalation"),
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");
    expect(harness.interruptTurn).toHaveBeenCalledWith({
      threadId,
      turnId: asTurnId("turn-interrupt-escalation"),
      controlRequestId: "command:cmd-interrupt-escalation",
      expectedLifecycleGeneration: "harness-session-1",
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId,
      controlRequestId: "command:cmd-interrupt-escalation",
      expectedLifecycleGeneration: "harness-session-1",
    });

    await dispatchHarnessUserTurn(harness, {
      messageId: "interrupt-escalation-follow-up",
      text: "Continue after interrupt escalation",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSessionWithOutcome).toHaveBeenCalledTimes(2);
    const sessions = await Effect.runPromise(harness.listSessions());
    expect(sessions).toEqual([
      expect.objectContaining({ threadId, resumeCursor: { opaque: "resume-1" } }),
    ]);
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    const followUpInput = harness.sendTurn.mock.calls[1]?.[0];
    expect(followUpInput?.input).toBe("Continue after interrupt escalation");
  });

  describe("interrupt escalation recovery", () => {
    async function createEscalatedHarness(provider: ProviderKind = "codex") {
      const harness = await createHarness({
        threadModelSelection: {
          provider,
          model:
            provider === "codex"
              ? "gpt-5-codex"
              : provider === "claudeAgent"
                ? "claude-opus-4-8"
                : "openai/gpt-5",
        },
        interruptTurn: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider,
              method: "turn/interrupt",
              detail: "connection closed after request write",
            }),
          ),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      await dispatchHarnessUserTurn(harness, {
        messageId: "escalation-seed",
        text: "Remember that the release train is amber.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: asTurnId("turn-1"),
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-escalation-stop"),
          threadId,
          turnId: asTurnId("turn-1"),
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
      return { harness, threadId };
    }

    async function readContextActivities(harness: Awaited<ReturnType<typeof createHarness>>) {
      return (
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ) ?? []
      );
    }

    it("attributes context-loss markers to interrupt escalation when history is gone", async () => {
      const harness = await createHarness({
        interruptTurn: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "turn/interrupt",
              detail: "connection closed after request write",
            }),
          ),
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: "interrupt-escalation-context-seed",
        text: "Remember that the release train is amber.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: asTurnId("turn-1"),
      });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-interrupt-escalation-context-loss"),
          threadId,
          turnId: asTurnId("turn-1"),
          createdAt: now,
        }),
      );
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");
      expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
        threadId,
        controlRequestId: "command:cmd-interrupt-escalation-context-loss",
        expectedLifecycleGeneration: "harness-session-1",
      });

      // Simulate residual cursor loss after the escalated stop (e.g. provider-side wipe).
      await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));

      await dispatchHarnessUserTurn(harness, {
        messageId: "interrupt-escalation-context-follow-up",
        text: "What release train did we pick?",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const followUpInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(followUpInput.input).toBe("What release train did we pick?");

      await waitFor(async () => {
        const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        );
        return lifecycleActivities?.length === 1;
      });
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        tone: "error",
        summary: "The turn could not be stopped cleanly, so the session was restarted.",
        payload: {
          provider: "codex",
          nativeHistory: "unavailable",
          sessionRestarted: true,
          restartReason: "interrupt-escalation",
          recapInjected: false,
          recapCharacters: 0,
          recapPreview: null,
          recapPreviewTruncated: false,
        },
      });
    });

    it.each(["attachment", "send"] as const)(
      "retains observed context loss after a failed %s dispatch",
      async (failure) => {
        const { harness, threadId } = await createEscalatedHarness();
        await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
        const attachment = {
          type: "image",
          id: `att_v2_${"a1b2c3d4".repeat(4)}`,
          name: "vanishes.png",
          mimeType: "image/png",
          sizeBytes: 3,
        } as const;
        if (failure === "attachment") {
          const attachmentPath = await harness.stageAttachment(attachment);
          const startSession = harness.startSession.getMockImplementation()!;
          // Initial command preflight succeeds; the file disappears while the
          // replacement session starts, before dispatch resolves attachments again.
          harness.startSession.mockImplementationOnce((...args) =>
            startSession(...args).pipe(
              Effect.tap(() => Effect.sync(() => fs.rmSync(attachmentPath))),
            ),
          );
        } else {
          harness.sendTurn.mockImplementationOnce(() =>
            Effect.fail(
              new ProviderAdapterValidationError({
                provider: "codex",
                operation: "turn/start",
                issue: "preflight rejected",
              }),
            ),
          );
        }
        await dispatchHarnessUserTurn(harness, {
          messageId: "escalation-failed-recovery",
          text: "Which release train did we pick?",
          createdAt: new Date().toISOString(),
          ...(failure === "attachment" ? { attachments: [attachment] } : {}),
        });
        await harness.drain();
        expect(harness.startSessionWithOutcome).toHaveBeenCalledTimes(2);
        expect(harness.sendTurn).toHaveBeenCalledTimes(failure === "attachment" ? 1 : 2);
        expect(await readContextActivities(harness)).toEqual([]);
        harness.sendTurn.mockImplementationOnce(() =>
          Effect.succeed({ threadId, turnId: asTurnId("recovery-accepted") }),
        );
        await dispatchHarnessUserTurn(harness, {
          messageId: "escalation-retry",
          text: "Retry the question.",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        expect(harness.startSessionWithOutcome).toHaveBeenCalledTimes(2);
        expect(await readContextActivities(harness)).toEqual([
          expect.objectContaining({
            turnId: asTurnId("recovery-accepted"),
            payload: expect.objectContaining({
              restartReason: "interrupt-escalation",
              nativeHistory: "unavailable",
              sessionRestarted: true,
              recapInjected: false,
            }),
          }),
        ]);
      },
    );

    it("keeps a clean native resume quiet across a rejected send and clears later attribution", async () => {
      const { harness, threadId } = await createEscalatedHarness();
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "turn/start",
            issue: "preflight rejected",
          }),
        ),
      );
      for (const messageId of ["clean-resume-failed", "clean-resume-retry"]) {
        await dispatchHarnessUserTurn(harness, {
          messageId,
          text: "Continue with the saved history.",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
      }
      expect(harness.startSessionWithOutcome).toHaveBeenCalledTimes(2);
      expect(await readContextActivities(harness)).toEqual([]);
      await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
      await dispatchHarnessUserTurn(harness, {
        messageId: "unrelated-history-loss",
        text: "A later unrelated restart.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(await readContextActivities(harness)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ restartReason: "native-history-unavailable" }),
        }),
      ]);
    });

    const staleResumeFailure = () =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "turn/setModel",
          detail:
            "Claude Code returned an error result: No conversation found with session ID: missing-session",
        }),
      );
    it.each(["before", "after"] as const)(
      "preserves escalation attribution when Claude recovery completes %s send returns",
      async (completionTiming) => {
        const { harness, threadId } = await createEscalatedHarness("claudeAgent");
        harness.sendTurn
          .mockImplementationOnce(staleResumeFailure)
          .mockImplementationOnce(staleResumeFailure)
          .mockImplementationOnce(() =>
            Effect.promise(async () => {
              if (completionTiming === "before") {
                await emitHarnessTurnTerminal(harness, {
                  provider: "claudeAgent",
                  type: "completed",
                  eventId: "claude-early-completion",
                  turnId: asTurnId("claude-recovered"),
                });
                // Let the runtime consumer record completion while send still owns
                // the attempt and has not returned its provider turn id.
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              return { threadId, turnId: asTurnId("claude-recovered") };
            }),
          );
        await dispatchHarnessUserTurn(harness, {
          messageId: "claude-escalation-recovery",
          text: "Which release train did we pick?",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        expect(harness.sendTurn).toHaveBeenCalledTimes(4);
        expect(harness.sendTurn.mock.calls[3]?.[0].input).toContain(
          "Remember that the release train is amber.",
        );
        if (completionTiming === "after") {
          expect(await readContextActivities(harness)).toEqual([]);
          await emitHarnessTurnTerminal(harness, {
            provider: "claudeAgent",
            type: "completed",
            eventId: "claude-late-completion",
            turnId: asTurnId("claude-recovered"),
          });
        }
        await waitFor(async () => (await readContextActivities(harness)).length === 1);
        expect(await readContextActivities(harness)).toEqual([
          expect.objectContaining({
            turnId: asTurnId("claude-recovered"),
            payload: expect.objectContaining({
              restartReason: "interrupt-escalation",
              recapInjected: true,
            }),
          }),
        ]);
      },
    );

    it("discards pending escalation context when the user explicitly stops recovery", async () => {
      const { harness, threadId } = await createEscalatedHarness("opencode");
      await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: "opencode",
            operation: "session/prompt",
            issue: "preflight rejected",
          }),
        ),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "discarded-recovery",
        text: "Try to recover.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain(
        "Remember that the release train is amber.",
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-explicit-recovery-stop"),
          threadId,
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      await dispatchHarnessUserTurn(harness, {
        messageId: "after-explicit-recovery-stop",
        text: "Continue without the discarded summary.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(harness.sendTurn.mock.calls.at(-1)?.[0].input).toBe(
        "Continue without the discarded summary.",
      );
      expect(await readContextActivities(harness)).toEqual([]);
    });

    it("retains claudeAgent escalation and skips duplicate summaries during native steer", async () => {
      const provider = "claudeAgent";
      const { harness, threadId } = await createEscalatedHarness(provider);
      harness.sendTurn
        .mockImplementationOnce(staleResumeFailure)
        .mockImplementationOnce(staleResumeFailure);
      const recoveryTurnId = asTurnId("recovery-before-steer");
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.succeed({ threadId, turnId: recoveryTurnId }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "recovery-before-steer",
        text: "Recover the previous context.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(await readContextActivities(harness)).toEqual([]);
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: recoveryTurnId,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-recovery-steer"),
          threadId,
          message: {
            messageId: asMessageId("recovery-steer"),
            role: "user",
            text: "Focus on the release train.",
            attachments: [],
          },
          dispatchMode: "steer",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      const steerInput = harness.steerTurn.mock.calls[0]?.[0] as { readonly input?: string };
      expect(steerInput.input).not.toContain("<thread_context>");
      harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      await emitHarnessTurnTerminal(harness, {
        provider,
        type: "failed",
        eventId: "steered-recovery-failed",
        turnId: recoveryTurnId,
      });
      await harness.drain();
      const retryTurnId = asTurnId("recovery-after-steer");
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.succeed({ threadId, turnId: retryTurnId }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "recovery-after-steer",
        text: "Retry after the failed steered recovery.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      await emitHarnessTurnTerminal(harness, {
        provider,
        type: "completed",
        eventId: "steered-recovery-completed",
        turnId: retryTurnId,
      });
      await waitFor(async () => (await readContextActivities(harness)).length === 1);
      expect(await readContextActivities(harness)).toEqual([
        expect.objectContaining({
          turnId: retryTurnId,
          payload: expect.objectContaining({ restartReason: "interrupt-escalation" }),
        }),
      ]);
    });

    // Every non-Codex provider shares one escalation-acceptance branch; Droid
    // and OpenCode also carry their own context-acceptance tracking.
    const asynchronousProviders = ["claudeAgent", "droid", "opencode"] as const;

    it.each(asynchronousProviders)(
      "retains %s escalation through failed and cancelled prompts until terminal success",
      async (provider) => {
        const { harness, threadId } = await createEscalatedHarness(provider);
        await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
        for (const state of ["failed", "cancelled", "completed"] as const) {
          const turnId = asTurnId(`${provider}-${state}`);
          harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId }));
          await dispatchHarnessUserTurn(harness, {
            messageId: `recover-${state}`,
            text: "Recover the interrupted session.",
            createdAt: new Date().toISOString(),
          });
          await harness.drain();
          expect(await readContextActivities(harness)).toEqual([]);
          await emitHarnessTurnTerminal(harness, {
            provider,
            type: state,
            eventId: `terminal-${turnId}`,
            turnId,
          });
          await harness.drain();
        }
        await waitFor(async () => (await readContextActivities(harness)).length === 1);
        const activities = await readContextActivities(harness);
        expect(activities).toEqual([
          expect.objectContaining({
            turnId: asTurnId(`${provider}-completed`),
            payload: expect.objectContaining({
              nativeHistory: "unavailable",
              restartReason: "interrupt-escalation",
            }),
          }),
        ]);
        await dispatchHarnessUserTurn(harness, {
          messageId: "normal-followup",
          text: "Continue normally.",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        expect(harness.sendTurn.mock.calls.at(-1)?.[0].input).toBe("Continue normally.");
        expect(await readContextActivities(harness)).toEqual(activities);
      },
    );

    it.each(asynchronousProviders)(
      "keeps a clean %s resume quiet after async failure and retires the cause on success",
      async (provider) => {
        const { harness, threadId } = await createEscalatedHarness(provider);
        for (const state of ["failed", "completed"] as const) {
          const turnId = asTurnId(`clean-${state}`);
          harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId }));
          await dispatchHarnessUserTurn(harness, {
            messageId: `clean-resume-${state}`,
            text: "Resume the existing history.",
            createdAt: new Date().toISOString(),
          });
          await harness.drain();
          await emitHarnessTurnTerminal(harness, {
            provider,
            type: state,
            eventId: `terminal-${turnId}`,
            turnId,
          });
          await harness.drain();
          expect(await readContextActivities(harness)).toEqual([]);
        }
        await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
        const turnId = asTurnId("unrelated-loss");
        harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId }));
        await dispatchHarnessUserTurn(harness, {
          messageId: "unrelated-history-loss",
          text: "Recover an unrelated lost session.",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        await emitHarnessTurnTerminal(harness, {
          provider,
          type: "completed",
          eventId: "unrelated-completed",
          turnId,
        });
        await waitFor(async () => (await readContextActivities(harness)).length === 1);
        expect((await readContextActivities(harness))[0]).not.toMatchObject({
          payload: { restartReason: "interrupt-escalation" },
        });
      },
    );

    it("retains escalation and summary until asynchronous recovery completes", async () => {
      const { harness, threadId } = await createEscalatedHarness("opencode");
      await Effect.runPromise(harness.clearSessionResumeCursor({ threadId }));
      for (const [index, turnId] of [
        asTurnId("async-aborted"),
        asTurnId("async-recovered"),
      ].entries()) {
        harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId }));
        await dispatchHarnessUserTurn(harness, {
          messageId: `async-recovery-${index}`,
          text: "Which release train did we pick?",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        expect(harness.sendTurn.mock.calls[index + 1]?.[0].input).toContain(
          "Remember that the release train is amber.",
        );
        expect(await readContextActivities(harness)).toEqual([]);
        await emitHarnessTurnTerminal(harness, {
          provider: "opencode",
          type: index === 0 ? "aborted" : "completed",
          eventId: `terminal-${turnId}`,
          turnId,
        });
        await harness.drain();
      }
      await waitFor(async () => (await readContextActivities(harness)).length === 1);
      const activities = await readContextActivities(harness);
      expect(activities).toEqual([
        expect.objectContaining({
          turnId: asTurnId("async-recovered"),
          payload: expect.objectContaining({
            restartReason: "interrupt-escalation",
            recapInjected: true,
          }),
        }),
      ]);
      await dispatchHarnessUserTurn(harness, {
        messageId: "after-async-recovery",
        text: "Continue normally.",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(harness.sendTurn.mock.calls.at(-1)?.[0].input).toBe("Continue normally.");
      expect(await readContextActivities(harness)).toEqual(activities);
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

    await setHarnessSession(harness, {
      commandId: "cmd-session-running-edit-rollback",
      status: "running",
      activeTurnId: asTurnId("turn-active-edit"),
      at: now,
    });
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

  describe("typed skills", () => {
    // The harness session runs in /tmp/provider-project, whose project skill folders
    // the shared catalog scans. Unique names keep real user skills out of the way.
    const projectRoot = "/tmp/provider-project";
    const suffix = Math.random().toString(36).slice(2, 10);
    const claudeSkillName = `synara-test-claude-${suffix}`;
    const codexSkillName = `synara-test-codex-${suffix}`;
    const createdSkillDirs: string[] = [];

    function writeProjectSkill(root: ".claude" | ".codex", name: string, body: string): string {
      const dir = path.join(projectRoot, root, "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      createdSkillDirs.push(dir);
      const skillPath = path.join(dir, "SKILL.md");
      fs.writeFileSync(skillPath, `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`);
      return skillPath;
    }

    function writeSkills() {
      return {
        claudePath: writeProjectSkill(".claude", claudeSkillName, "CLAUDE SKILL BODY"),
        codexPath: writeProjectSkill(".codex", codexSkillName, "CODEX SKILL BODY"),
      };
    }

    afterEach(() => {
      for (const dir of createdSkillDirs.splice(0))
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function sendTyped(
      harness: Awaited<ReturnType<typeof createHarness>>,
      text: string,
      dispatchOrigin?: "user" | "agent",
    ) {
      await dispatchHarnessUserTurn(harness, {
        messageId: `typed-skill-${Math.random().toString(36).slice(2)}`,
        text,
        createdAt: new Date().toISOString(),
        ...(dispatchOrigin ? { dispatchOrigin } : {}),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      return harness.sendTurn.mock.calls[0]![0];
    }

    const claudeHarness = () =>
      createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
      });

    it("gives Claude the instructions of a skill typed mid-sentence", async () => {
      const { claudePath } = writeSkills();
      const turn = await sendTyped(await claudeHarness(), `Please run /${claudeSkillName} on this`);
      expect(turn.input).toContain(`Please run /${claudeSkillName} on this`);
      expect(turn.input).toContain(`<skill name="${claudeSkillName}"`);
      expect(turn.input).toContain("CLAUDE SKILL BODY");
      expect(turn.skills).toEqual([{ name: claudeSkillName, path: claudePath }]);
    });

    it("lets Claude Code load a .claude skill that starts the message", async () => {
      writeSkills();
      const turn = await sendTyped(await claudeHarness(), `/${claudeSkillName} fix the bugs`);
      expect(turn.input?.startsWith(`/${claudeSkillName} fix the bugs`)).toBe(true);
      expect(turn.input).not.toContain("<skill name=");
    });

    it("inlines a leading Claude skill followed by a colon as a mention", async () => {
      const { claudePath } = writeSkills();
      const turn = await sendTyped(await claudeHarness(), `/${claudeSkillName}: fix the bugs`);
      expect(turn.input?.startsWith(`$${claudeSkillName}: fix the bugs`)).toBe(true);
      expect(turn.input).toContain("CLAUDE SKILL BODY");
      expect(turn.skills).toEqual([{ name: claudeSkillName, path: claudePath }]);
    });

    it("hands Claude a leading skill shared from Codex as a mention with its instructions", async () => {
      writeSkills();
      const turn = await sendTyped(await claudeHarness(), `/${codexSkillName} fix the bugs`);
      expect(turn.input?.startsWith(`$${codexSkillName} fix the bugs`)).toBe(true);
      expect(turn.input).toContain("CODEX SKILL BODY");
    });

    it("sends typed skills to Codex as $mentions with skill references", async () => {
      const { claudePath, codexPath } = writeSkills();
      const turn = await sendTyped(
        await createHarness(),
        `Use /${codexSkillName} and /${claudeSkillName} now`,
      );
      expect(turn.input).toContain(`Use $${codexSkillName} and $${claudeSkillName} now`);
      expect(turn.skills).toEqual([
        { name: codexSkillName, path: codexPath },
        { name: claudeSkillName, path: claudePath },
      ]);
      // Codex loads its own folder natively; the shared Claude skill travels inline.
      expect(turn.input).toContain("CLAUDE SKILL BODY");
      expect(turn.input).not.toContain("CODEX SKILL BODY");
    });

    it("sends the active Codex profile's copy of a typed skill before its default-home copy", async () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-codex-skill-home-"));
      createdSkillDirs.push(homeDir);
      const customHome = path.join(homeDir, "work-codex");
      const skillDir = path.join("skills", codexSkillName);
      for (const codexHome of [path.join(homeDir, ".codex"), customHome]) {
        fs.mkdirSync(path.join(codexHome, skillDir), { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, skillDir, "SKILL.md"),
          `---\nname: ${codexSkillName}\ndescription: test skill\n---\n`,
        );
      }
      const turn = await sendTyped(
        await createHarness({
          threadModelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5" },
          skillCatalogHomeDir: homeDir,
          serverSettings: {
            providerInstances: {
              codex_work: { driver: "codex", enabled: true, config: { homePath: customHome } },
            },
          },
          listNativeSkills: ({ homePath }) =>
            Effect.succeed({
              skills: homePath
                ? [
                    {
                      name: codexSkillName,
                      path: path.join(homePath, skillDir, "SKILL.md"),
                      enabled: true,
                    },
                  ]
                : [],
            }),
        }),
        `Please use /${codexSkillName}`,
      );
      expect(turn.input).toContain(`Please use $${codexSkillName}`);
      expect(turn.skills).toEqual([
        { name: codexSkillName, path: path.join(customHome, skillDir, "SKILL.md") },
      ]);
    });

    it.each(["homePath", "configDir"] as const)(
      "uses the active Claude %s for typed skills and native slash commands",
      async (configuredDir) => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-claude-skill-home-"));
        createdSkillDirs.push(homeDir);
        const customHome = path.join(homeDir, "work-claude");
        const customConfig =
          configuredDir === "homePath" ? path.join(customHome, ".claude") : customHome;
        const skillDir = path.join("skills", claudeSkillName);
        const defaultConfig = path.join(homeDir, ".claude");
        for (const [configDir, body] of [
          [defaultConfig, "DEFAULT CLAUDE SKILL BODY"],
          [customConfig, "CUSTOM CLAUDE SKILL BODY"],
        ] as const) {
          fs.mkdirSync(path.join(configDir, skillDir), { recursive: true });
          fs.writeFileSync(
            path.join(configDir, skillDir, "SKILL.md"),
            `---\nname: ${claudeSkillName}\ndescription: test skill\n---\n${body}\n`,
          );
        }
        const makeHarness = () =>
          createHarness({
            threadModelSelection: {
              provider: "claudeAgent",
              instanceId: "claude_work",
              model: "claude-opus-4-6",
            },
            skillCatalogHomeDir: homeDir,
            serverSettings: {
              providerInstances: {
                claude_work: {
                  driver: "claudeAgent",
                  enabled: true,
                  config: { [configuredDir]: customHome },
                },
              },
            },
          });

        const inline = await sendTyped(await makeHarness(), `Please use /${claudeSkillName}`);
        expect(inline.input).toContain("CUSTOM CLAUDE SKILL BODY");
        expect(inline.input).not.toContain("DEFAULT CLAUDE SKILL BODY");
        const command = `/${claudeSkillName} review this`;
        const native = await sendTyped(await makeHarness(), command);
        expect(native.input?.startsWith(command)).toBe(true);
        expect(native.input).not.toContain("<skill name=");
        expect(native.skills).toEqual([
          { name: claudeSkillName, path: path.join(customConfig, skillDir, "SKILL.md") },
        ]);
      },
    );

    it("keeps typed and explicitly attached OMP skills on their existing paths", async () => {
      const { claudePath } = writeSkills();
      const skill = { name: claudeSkillName, path: claudePath };
      const text = `Please use $${claudeSkillName}`;
      const makeHarness = () =>
        createHarness({ threadModelSelection: { provider: "omp", model: "model-a" } });

      const typed = await sendTyped(await makeHarness(), text);
      expect(typed.input).toBe(text);
      expect(typed.skills).toBeUndefined();

      const attachedHarness = await makeHarness();
      await Effect.runPromise(
        attachedHarness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-omp-explicit-skill"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("omp-explicit-skill"),
            role: "user",
            text,
            attachments: [],
            skills: [skill],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => attachedHarness.sendTurn.mock.calls.length === 1);
      const attached = attachedHarness.sendTurn.mock.calls[0]![0];
      expect(attached.skills).toEqual([skill]);
      expect(attached.input).toContain("CLAUDE SKILL BODY");
    });

    it("ignores skill tokens in another agent's message", async () => {
      writeSkills();
      const turn = await sendTyped(await claudeHarness(), `Please /${claudeSkillName}`, "agent");
      expect(turn.skills).toBeUndefined();
      expect(turn.input).not.toContain("<skill name=");
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

    await harness.stageAttachment(imageAttachment);

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
    await setHarnessSession(harness, {
      commandId: "cmd-session-running-edit-resend",
      status: "running",
      activeTurnId: asTurnId("turn-active-edit-resend"),
      at: now,
    });

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

  it.each(["thread-1", "ios:11111111-1111-4111-8111-111111111111:thread"])(
    "delivers HTTP-uploaded photos through their owning host and provider for %s",
    async (rawThreadId) => {
      const photo = fs.readFileSync(
        fileURLToPath(new URL("../../__fixtures__/tiny-remote-photo.jpg", import.meta.url)),
      );
      const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      const threadId = ThreadId.makeUnsafe(rawThreadId);
      let firstHostAttachment: ChatImageAttachment | undefined;
      for (const host of ["mini", "book"]) {
        const received: Parameters<ProviderServiceShape["sendTurn"]>[0][] = [];
        const harness = await createHarness({
          providerServiceLayer: createRetainingRestartProviderServiceLayer({
            failFirstTeardown: false,
            onSendTurn: (input) => received.push(input),
          }),
        });
        const serverScope = await Effect.runPromise(Scope.make("sequential"));
        scopes.add(serverScope);
        const controlPlane = AuthControlPlaneLive.pipe(Layer.provide(AuthCoreLive));
        const auth = ServerAuthLive.pipe(
          Layer.provide(ServerAuthPolicyLive),
          Layer.provide(controlPlane),
          Layer.provide(AuthCoreLive),
        );
        const authServices = await harness.runtime.runPromise(
          Layer.buildWithScope(
            Layer.mergeAll(auth, AuthCoreLive).pipe(Layer.provideMerge(RemoteSessionRegistryLive)),
            serverScope,
          ),
        );
        const sessions = ServiceMap.get(authServices, SessionCredentialService);
        const leases = await Promise.all(
          ["upload", "rpc", "other"].map((label) =>
            Effect.runPromise(
              sessions.issue({ role: "client", client: { label, deviceType: "mobile" } }),
            ),
          ),
        );
        const [uploadLease, rpcLease, otherLease] = leases;
        const unbind = leases.map((lease, index) =>
          bindRemoteAttachmentSession(lease!.sessionId, {
            environmentId: host,
            rootFingerprint: `fixture-root-${host}`,
            userId: "fixture-owner",
            deviceJkt: index === 2 ? "another-device" : "phone-or-desktop-device",
            trustGeneration: 1,
          }),
        );
        try {
          const origin = await harness.runtime.runPromise(
            Scope.provide(
              Effect.gen(function* () {
                const server = yield* NodeHttpServer.make(() => http.createServer(), {
                  port: 0,
                  host: "127.0.0.1",
                });
                const handler = yield* HttpRouter.toHttpEffect(
                  Layer.mergeAll(binaryUploadEffectRouteLayer, attachmentsEffectRouteLayer),
                );
                yield* server.serve(handler);
                if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP server");
                return `http://127.0.0.1:${server.address.port}`;
              }).pipe(
                Effect.provideServices(authServices),
                Effect.provideService(ProviderAdapterRegistry, {
                  getByProvider: () => Effect.die("Voice is not used in the photo fixture"),
                  listProviders: () => Effect.succeed([]),
                }),
              ),
              serverScope,
            ),
          );
          const rpcPrincipal = attachmentPrincipalForSession(rpcLease!.sessionId);
          expect(attachmentPrincipalForSession(uploadLease!.sessionId)).toEqual(rpcPrincipal);
          if (rawThreadId !== "thread-1") {
            await Effect.runPromise(
              harness.engine.dispatch({
                type: "thread.create",
                commandId: CommandId.makeUnsafe(`cmd-photo-create-${host}`),
                threadId,
                projectId: asProjectId("project-1"),
                title: "Phone photo fixture",
                modelSelection: { provider: "codex", model: "gpt-5" },
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                runtimeMode: "approval-required",
                branch: null,
                worktreePath: null,
                createdAt: new Date().toISOString(),
              }),
            );
          }
          const upload = async () => {
            const query = new URLSearchParams({
              type: "image",
              threadId,
              name: "phone-photo.jpg",
              mimeType: "image/jpeg",
            });
            const response = await fetch(`${origin}/api/attachments/upload?${query}`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${uploadLease!.token}`,
                "content-type": "image/jpeg",
              },
              body: photo,
            });
            const payload = await response.json();
            expect(response.status, JSON.stringify(payload)).toBe(201);
            expect(payload).toMatchObject({
              type: "image",
              mimeType: "image/jpeg",
              sizeBytes: photo.length,
            });
            return payload as ChatImageAttachment;
          };
          const dispatch = (
            attachment: ChatImageAttachment,
            suffix: string,
            principal = rpcPrincipal,
          ) =>
            Effect.runPromise(
              harness.engine.dispatch(
                {
                  type: "thread.turn.start",
                  commandId: CommandId.makeUnsafe(`cmd-photo-${host}-${suffix}`),
                  threadId,
                  message: {
                    messageId: asMessageId(`message-photo-${host}-${suffix}`),
                    role: "user",
                    text: "Inspect this photo",
                    attachments: [attachment],
                  },
                  runtimeMode: "approval-required",
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  createdAt: new Date().toISOString(),
                },
                { attachmentPrincipal: principal },
              ),
            );
          const cancel = (attachment: ChatImageAttachment, token: string) =>
            fetch(`${origin}/api/attachments/cancel`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ attachmentId: attachment.id }),
            });
          if (firstHostAttachment) {
            await expect(dispatch(firstHostAttachment, "wrong-host")).rejects.toThrow(
              "unavailable",
            );
            expect(received).toHaveLength(0);
          }
          const cancelled = await upload();
          expect((await cancel(cancelled, otherLease!.token)).status).toBe(404);
          expect((await cancel(cancelled, uploadLease!.token)).status).toBe(200);
          await expect(dispatch(cancelled, "cancelled")).rejects.toThrow("unavailable");
          const attachment = await upload();
          await expect(
            dispatch(
              attachment,
              "wrong-owner",
              attachmentPrincipalForSession(otherLease!.sessionId),
            ),
          ).rejects.toThrow("unavailable");
          expect(received).toHaveLength(0);
          await dispatch(attachment, "accepted");
          await waitFor(() => received.length === 1);
          const sent = received[0]!.attachments?.[0];
          expect(sent).toMatchObject(attachment);
          const storagePath =
            sent &&
            resolveProviderAttachmentPath({
              attachmentsDir: path.join(harness.stateDir, "attachments"),
              attachment: sent,
            });
          expect(storagePath).toContain(`${path.sep}objects${path.sep}`);
          expect(digest(fs.readFileSync(storagePath!))).toBe(digest(photo));
          const blocks = await Effect.runPromise(
            loadProviderPromptImageBlocks({
              attachments: received[0]!.attachments,
              attachmentsDir: path.join(harness.stateDir, "attachments"),
              provider: "codex",
              method: "turn/start",
              readFile: (file) => Effect.tryPromise(() => fs.promises.readFile(file)),
            }),
          );
          expect(blocks).toEqual([
            { type: "image", mimeType: "image/jpeg", data: photo.toString("base64") },
          ]);
          const preview = await fetch(`${origin}/attachments/${attachment.id}`, {
            headers: { authorization: `Bearer ${rpcLease!.token}` },
          });
          expect(preview.status).toBe(200);
          expect(digest(new Uint8Array(await preview.arrayBuffer()))).toBe(digest(photo));
          expect((await cancel(attachment, uploadLease!.token)).status).toBe(409);
          firstHostAttachment = attachment;
        } finally {
          unbind.forEach((release) => release());
          await Effect.runPromise(Scope.close(serverScope, Exit.void));
        }
      }
    },
    20_000,
  );

  it("dispatches managed attachments from their repository object paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const imageAttachment = {
      type: "image" as const,
      id: "att_v2_aa000000000000000000000000000000",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const storagePath = await harness.stageAttachment(imageAttachment);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-managed-object-path-generic-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-managed-object-path"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-managed-object-path"),
          role: "user",
          text: "Inspect this image",
          attachments: [imageAttachment],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const sentAttachment = harness.sendTurn.mock.calls[0]?.[0].attachments?.[0];
    expect(sentAttachment).toMatchObject(imageAttachment);
    expect(
      sentAttachment &&
        resolveProviderAttachmentPath({
          attachmentsDir: path.join(harness.stateDir, "attachments"),
          attachment: sentAttachment,
        }),
    ).toBe(storagePath);

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const titleAttachment = harness.generateThreadTitle.mock.calls[0]?.[0].attachments?.[0];
    expect(
      titleAttachment &&
        resolveProviderAttachmentPath({
          attachmentsDir: path.join(harness.stateDir, "attachments"),
          attachment: titleAttachment,
        }),
    ).toBe(storagePath);
  });

  it.each([
    { name: "reloads its native session", nativeResume: true, bootstraps: false },
    { name: "cannot reload its native session", nativeResume: false, bootstraps: true },
  ])("bootstraps a Droid model switch only when it $name", async ({ nativeResume, bootstraps }) => {
    const harness = await createHarness({
      threadModelSelection: { provider: "droid", model: "model-a" },
      sessionModelSwitch: "restart-session",
      confirmNativeResume: () => nativeResume,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-droid-model-switch"),
        threadId,
        messages: [
          {
            messageId: asMessageId("droid-switch-earlier-user"),
            role: "user",
            text: "Earlier question",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("droid-switch-earlier-assistant"),
            role: "assistant",
            text: "Earlier answer",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    for (const [index, model] of ["model-a", "model-b"].entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-droid-model-switch-${index}`),
          threadId,
          message: {
            messageId: asMessageId(`droid-model-switch-user-${index}`),
            role: "user",
            text: `turn on ${model}`,
            attachments: [],
          },
          modelSelection: { provider: "droid", model },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
    }

    expect(harness.startSessionWithOutcome.mock.calls).toHaveLength(2);
    expect(harness.startSessionWithOutcome.mock.calls[1]?.[1]).toMatchObject({
      modelSelection: { provider: "droid", model: "model-b" },
    });
    const switched = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(switched?.input?.includes("<thread_context>")).toBe(bootstraps);
    expect(switched?.input).toContain("turn on model-b");
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
    await dispatchHarnessUserTurn(harness, {
      messageId: "droid-edit-target",
      text: "old prompt",
      createdAt: now,
      commandId: "cmd-droid-original-edit-turn",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockClear();
    await setHarnessSession(harness, {
      commandId: "cmd-droid-active-edit-session",
      status: "running",
      providerName: "droid",
      activeTurnId: asTurnId("turn-droid-active-edit"),
      at: now,
    });

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

  it.each(["opencode"] as const)(
    "keeps the %s edit recap pending until the replay turn completes",
    async (provider) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model: "openai/gpt-5" },
        conversationRollback: "restart-session",
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const rejectedTurnId = asTurnId(`${provider}-edit-replay-rejected`);
      const retryTurnId = asTurnId(`${provider}-edit-replay-retry`);
      const now = new Date().toISOString();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(`cmd-import-${provider}-edit-context`),
          threadId,
          messages: [
            {
              messageId: asMessageId(`${provider}-edit-earlier-user`),
              role: "user",
              text: "Earlier question",
              createdAt: now,
              updatedAt: now,
            },
            {
              messageId: asMessageId(`${provider}-edit-earlier-assistant`),
              role: "assistant",
              text: "Earlier answer",
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-edit-target`,
        text: "old prompt",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      harness.sendTurn.mockClear();
      harness.sendTurn
        .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: rejectedTurnId }))
        .mockImplementationOnce(() => Effect.succeed({ threadId, turnId: retryTurnId }));
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: asTurnId(`${provider}-edit-active`),
      });
      await setHarnessSession(harness, {
        commandId: `cmd-${provider}-edit-session-running`,
        threadId,
        status: "running",
        providerName: provider,
        activeTurnId: asTurnId(`${provider}-edit-active`),
        at: now,
      });

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.edit-and-resend",
          commandId: CommandId.makeUnsafe(`cmd-${provider}-edit-and-resend`),
          threadId,
          messageId: asMessageId(`${provider}-edit-target`),
          text: "edited prompt",
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      const rejectedInput = harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string };
      expect(rejectedInput.input).toContain("<thread_context>");
      expect(rejectedInput.input).toContain("Earlier answer");
      expect(rejectedInput.input).toContain("edited prompt");
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);

      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-edit-replay-aborted`,
        provider,
        type: "aborted",
        turnId: rejectedTurnId,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toEqual([]);

      await dispatchHarnessUserTurn(harness, {
        messageId: `${provider}-edit-replay-retry-message`,
        text: "Retry the edited request.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const retryInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
      expect(retryInput.input).toContain("<thread_context>");
      expect(retryInput.input).toContain("edited prompt");

      await emitHarnessTurnTerminal(harness, {
        eventId: `${provider}-edit-replay-completed`,
        provider,
        type: "completed",
        turnId: retryTurnId,
      });
      await waitFor(async () => {
        const lifecycleActivities = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "provider.context.changed",
        );
        return lifecycleActivities?.length === 1;
      });
      const [lifecycleActivity] = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "provider.context.changed",
      ) ?? [undefined];
      expect(lifecycleActivity).toMatchObject({
        turnId: retryTurnId,
        payload: {
          provider,
          nativeHistory: "unavailable",
          sessionRestarted: false,
          restartReason: "conversation-rebuilt",
          recapInjected: true,
        },
      });
    },
  );

  it("keeps queued-message edits queued while an active provider turn continues", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running-edit-queued"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-running-edit-queued",
      status: "running",
      activeTurnId: asTurnId("turn-running-edit-queued"),
      at: now,
    });

    await dispatchHarnessUserTurn(harness, {
      messageId: "msg-queued-before-edit",
      text: "queued prompt",
      createdAt: now,
      commandId: "cmd-turn-queued-before-edit",
    });
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
    await harness.stageAttachment(imageAttachment);

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

  it.each(["success", "capture-failed", "rollback-failed", "restore-failed"] as const)(
    "preserves edit replay recovery when %s",
    async (mode) => {
      const deletedRefs = vi.fn<CheckpointStoreShape["deleteCheckpointRefs"]>(() => Effect.void);
      const harness = await createHarness({
        checkpointStore: { deleteCheckpointRefs: deletedRefs },
      });
      const operations: string[] = [];
      const gitFailure = () =>
        new GitCommandError({
          operation: "test.edit-recovery",
          cwd: "/tmp/provider-project",
          command: "git",
          detail: mode,
        });
      harness.captureCheckpoint.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("capture");
          return mode === "capture-failed" ? Effect.fail(gitFailure()) : Effect.void;
        }),
      );
      harness.rollbackConversation.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("rollback");
          return mode === "rollback-failed"
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread/rollback",
                  detail: mode,
                }),
              )
            : Effect.void;
        }),
      );
      harness.restoreCheckpoint.mockImplementation(() =>
        Effect.suspend(() => {
          operations.push("restore");
          return mode === "restore-failed" ? Effect.fail(gitFailure()) : Effect.succeed(true);
        }),
      );
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

      if (mode === "success") {
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.restoreCheckpoint).toHaveBeenCalledWith({
          cwd: "/tmp/provider-project",
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
          fallbackToHead: true,
        });
        expect(operations).toEqual(["capture", "rollback", "restore"]);
      } else {
        await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (mode === "capture-failed") {
          expect(harness.rollbackConversation).not.toHaveBeenCalled();
          expect(harness.restoreCheckpoint).not.toHaveBeenCalled();
        }
        expect((await readHarnessThread(harness))?.session?.lastError).toContain(mode);
      }
      expect(deletedRefs).not.toHaveBeenCalled();
      const rescueRef = harness.captureCheckpoint.mock.calls[0]?.[0].checkpointRef;
      expect(rescueRef).toContain("/revert-rescue/");
      expect((await readHarnessThread(harness))?.activities).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "checkpoint.edit-replay.snapshot" }),
        ]),
      );
    },
  );

  it("retains a discoverable file recovery snapshot across edit replay and store restart", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-edit-replay-recovery-"));
    createdBaseDirs.add(cwd);
    const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git(["init", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "baseline\n");
    git(["add", "."]);
    git(["commit", "-m", "Initial"]);
    const storeLayer = CheckpointStoreLive.pipe(
      Layer.provide(
        GitCoreLive.pipe(
          Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synara-edit-replay-recovery-" })),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    const firstRuntime = ManagedRuntime.make(storeLayer);
    runtimes.add(firstRuntime);
    const store = await firstRuntime.runPromise(Effect.service(CheckpointStore));
    const harness = await createHarness({ checkpointStore: store });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("edit-recovery-real-project"),
        projectId: asProjectId("project-1"),
        workspaceRoot: cwd,
      }),
    );
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-edit-recovery-real"),
      turnId: asTurnId("turn-edit-recovery-real"),
      createdAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("edit-recovery-real-checkpoint"),
        threadId,
        turnId: asTurnId("turn-edit-recovery-real"),
        completedAt: now,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [],
        assistantMessageId: asMessageId("assistant-user-edit-recovery-real"),
        checkpointTurnCount: 1,
        createdAt: now,
      }),
    );
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "user changed this after the turn\n");
    fs.writeFileSync(path.join(cwd, "untracked.txt"), "unsaved elsewhere\n");
    let refsBeforeRollback = "";
    harness.rollbackConversation.mockImplementation(() =>
      Effect.sync(() => {
        refsBeforeRollback = git([
          "for-each-ref",
          "--format=%(refname)",
          "refs/synara/checkpoints",
        ]);
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.edit-and-resend",
        commandId: CommandId.makeUnsafe("edit-recovery-real-resend"),
        threadId,
        messageId: asMessageId("user-edit-recovery-real"),
        text: "edited checkpoint prompt",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    // Provider history can be trimmed only after durable file recovery exists.
    expect(refsBeforeRollback).toContain("/revert-rescue/");
    expect(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8")).toBe("baseline\n");
    expect(fs.existsSync(path.join(cwd, "untracked.txt"))).toBe(false);
    const rescueRefs = git(["for-each-ref", "--format=%(refname)", "refs/synara/checkpoints"])
      .trim()
      .split("\n")
      .filter(
        (ref) => ref.includes("/revert-rescue/") && isManagedCheckpointRefForThread(ref, threadId),
      );
    expect(rescueRefs).toHaveLength(1);
    await firstRuntime.dispose();
    runtimes.delete(firstRuntime);
    const reopenedRuntime = ManagedRuntime.make(storeLayer);
    runtimes.add(reopenedRuntime);
    await reopenedRuntime.runPromise(
      Effect.gen(function* () {
        const reopenedStore = yield* CheckpointStore;
        expect(
          yield* reopenedStore.restoreCheckpoint({
            cwd,
            checkpointRef: CheckpointRef.makeUnsafe(rescueRefs[0]!),
          }),
        ).toBe(true);
      }),
    );
    expect(fs.readFileSync(path.join(cwd, "tracked.txt"), "utf8")).toBe(
      "user changed this after the turn\n",
    );
    expect(fs.readFileSync(path.join(cwd, "untracked.txt"), "utf8")).toBe("unsaved elsewhere\n");
    expect((await readHarnessThread(harness))?.activities).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "checkpoint.edit-replay.snapshot" }),
      ]),
    );
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

    await seedRollbackTarget(harness, {
      messageId: asMessageId("user-message-edit-fails"),
      turnId: asTurnId("turn-edit-rollback-failure"),
      createdAt: now,
    });

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

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("rollback failed");
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((items) => Array.from(items)),
      ),
    );
    const editEvent = events.find(
      (event) =>
        event.commandId === "cmd-edit-and-resend-rollback-fails" &&
        event.type === "thread.message-edit-resend-requested",
    );
    expect(editEvent).toBeDefined();
    await waitFor(async () => {
      const delivery = await Effect.runPromise(
        harness.deliveryRepository.getDelivery({
          consumerName: "provider-command-reactor.v1",
          eventSequence: editEvent!.sequence,
        }),
      );
      return Option.isSome(delivery) && delivery.value.state === "uncertain";
    });
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

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("turn start failed");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
    const failure = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.start.failed",
    );
    const detail = (failure?.payload as { detail?: string } | undefined)?.detail;
    expect(detail).toContain("turn start failed");
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain(" at ");
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

  it.each([
    { switchOn: false as const, after: "none", expected: false },
    { switchOn: true as const, after: "none", expected: true },
    { switchOn: true as const, after: "disable-reenable", expected: false },
    { switchOn: true as const, after: "ordinary-turn", expected: false },
  ])(
    "only current Settings opt-in survives into goal continuation (Computer switch=$switchOn with $after gives goal continuation exposure=$expected)",
    async ({ switchOn, after, expected }) => {
      const manager = new ComputerManager({ backend: new FakeComputerBackend() });
      const harness = await createHarness({
        computerService: {
          supported: true,
          availability: { kind: "available", backend: "fake" },
          manager,
        },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      try {
        const sendUserTurn = async (index: number, switchOn?: boolean) => {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`computer-goal-user-${index}`),
              threadId,
              message: {
                messageId: asMessageId(`computer-goal-message-${index}`),
                role: "user",
                text: "Continue",
                attachments: [],
              },
              ...(switchOn !== undefined
                ? { enableComputerControl: switchOn, computerControlGeneration: 0 }
                : {}),
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt,
            }),
          );
          await waitFor(() => harness.sendTurn.mock.calls.length === index);
          harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
          await setHarnessSession(harness, {
            commandId: `computer-goal-ready-${index}`,
            threadId,
            status: "ready",
            at: createdAt,
          });
        };
        await sendUserTurn(1, switchOn);
        if (after === "ordinary-turn") await sendUserTurn(2);
        if (after === "disable-reenable") {
          await manager.setControlEnabled(threadId, false);
          await manager.setControlEnabled(threadId, true);
        }
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("computer-goal-create"),
            threadId,
            goal: "Complete the desktop task",
            goalStartBehavior: "defer",
          }),
        );
        const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt ?? null;
        const priorCalls = harness.sendTurn.mock.calls.length;
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("computer-goal-continue"),
            threadId,
            goalStartedAt,
            trigger: "startup-recovery",
            createdAt,
          }),
        );
        await waitFor(() => harness.sendTurn.mock.calls.length > priorCalls);
        expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(expected);
        expect(manager.canContinueChatControl(threadId)).toBe(expected);
      } finally {
        await manager.dispose();
      }
    },
  );

  it("delivers requested AppSnap source metadata without exposing Computer tools", async () => {
    const harness = await createHarness();
    const attachment = {
      type: "image" as const,
      id: "appsnap-context",
      name: "AppSnap - Preview - report - 2026-09-08T12:00:00.000Z.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    await harness.stageAttachment(attachment);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("appsnap-context-turn"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("appsnap-context-message"),
          role: "user",
          text: "Explain this image",
          attachments: [attachment],
        },
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1].enableComputerControl).toBe(false);
    const sent = harness.sendTurn.mock.calls[0]?.[0];
    expect(sent?.attachments).toHaveLength(1);
    expect(sent?.input).toContain('"source":"Preview - report"');
    expect(sent?.input).toContain('"capturedAt":"2026-09-08T12:00:00.000Z"');
    expect(sent?.input?.match(/AppSnap image metadata/g)).toHaveLength(1);
  });

  it("restarts the provider off → one Computer request → off without persisting consent", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const harness = await createHarness({
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    try {
      for (const [index, text] of [
        "Explain the project",
        "/computer-use open Calculator",
        "Explain the result",
      ].entries()) {
        if (index > 0) {
          harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
          await setHarnessSession(harness, {
            commandId: `computer-invocation-ready-${index}`,
            threadId,
            status: "ready",
            at: createdAt,
          });
        }
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`computer-invocation-${index}`),
            threadId,
            message: {
              messageId: asMessageId(`computer-invocation-message-${index}`),
              role: "user",
              text,
              attachments: [],
            },
            enableComputerControl: false,
            computerControlGeneration: 0,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
        expect(manager.canContinueChatControl(threadId)).toBe(false);
      }
      expect(
        harness.startSession.mock.calls.map(([, input]) => input.enableComputerControl),
      ).toEqual([false, true, false]);
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("open Calculator");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).not.toContain("/computer-use");
      expect(
        (await readHarnessThread(harness))?.messages.find(
          (message) => message.id === asMessageId("computer-invocation-message-1"),
        )?.text,
      ).toBe("/computer-use open Calculator");
    } finally {
      await manager.dispose();
    }
  });

  it("a frozen switch-off turn records no durable intent for the next ordinary turn", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const harness = await createHarness({
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    try {
      for (const [index, activation] of [
        { enableComputerControl: false as const, computerControlGeneration: 0 },
        {},
      ].entries()) {
        if (index > 0) {
          harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
          await setHarnessSession(harness, {
            commandId: `computer-ready-${index}`,
            threadId,
            status: "ready",
            at: createdAt,
          });
        }
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`computer-request-${index}`),
            threadId,
            message: {
              messageId: asMessageId(`computer-message-${index}`),
              role: "user",
              text: "Continue",
              attachments: [],
            },
            ...activation,
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
      }
      expect(
        harness.startSession.mock.calls.map(([, input]) => input.enableComputerControl),
      ).toEqual([false]);
      // The frozen switch-off turn admitted nothing durable, so the follow-up
      // ordinary turn reuses the computer-less session (no restart, no second
      // startSession call) and still sends without Computer.
      expect(harness.sendTurn.mock.calls.length).toBe(2);
      expect(manager.canContinueChatControl(threadId)).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("stop clears durable chat intent so the next ordinary turn drops Computer", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const harness = await createHarness({
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    const markSessionReady = () =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(
            `computer-stop-ready-${harness.sendTurn.mock.calls.length}`,
          ),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
    try {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("computer-stop-chat"),
          threadId,
          message: {
            messageId: asMessageId("computer-stop-message-1"),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          enableComputerControl: true,
          computerControlGeneration: 0,
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(true);
      expect(manager.canContinueChatControl(threadId)).toBe(true);
      await markSessionReady();
      // Stop is an explicit off: the durable intent is cleared even though no
      // turn carried a switch-off.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("computer-stop"),
          threadId,
          createdAt,
        }),
      );
      await harness.drain();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(manager.canContinueChatControl(threadId)).toBe(false);
      await markSessionReady();
      await dispatchHarnessUserTurn(harness, {
        messageId: "computer-stop-message-2",
        text: "Continue",
        createdAt,
        threadId,
        commandId: "computer-stop-after",
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(false);
      expect(manager.canContinueChatControl(threadId)).toBe(false);
    } finally {
      await manager.dispose();
    }
  });
});
