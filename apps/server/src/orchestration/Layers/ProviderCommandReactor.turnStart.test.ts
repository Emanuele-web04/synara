// FILE: ProviderCommandReactor.turnStart.test.ts
// Purpose: ProviderCommandReactor cases for turn-start baselines, stale resume recovery, title generation, gateway operations, and queued promotion.
// Layer: Orchestration integration tests
// Depends on: providerCommandReactorHarness (ProviderCommandReactorLive with in-memory provider
//             and persistence services).
// Note: one contiguous slice of the former single ProviderCommandReactor.test.ts, in its
//       original order, so CI can run the slices on separate workers.

import fs from "node:fs";
import path from "node:path";
import type { ProviderKind, ProviderRuntimeEvent } from "@synara/contracts";
import {
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ThreadId,
} from "@synara/contracts";
import {
  Duration,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAgentGatewaySessionRegistry } from "../../agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend.ts";
import { ServerConfig } from "../../config.ts";
import { GitCommandError } from "../../git/Errors.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { HubOutputReactorLive } from "./HubOutputReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";
import { PROVIDER_DEBUG_MODE_PROMPT_PREFIX } from "../../provider/debugMode.ts";
import { type CheckpointStoreShape } from "../../checkpointing/Services/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  asProjectId,
  asEventId,
  asMessageId,
  asTurnId,
  waitFor,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("ProviderCommandReactor", () => {
  let scope: Scope.Closeable | null = null;
  const {
    scopes,
    createHarness,
    readHarnessThread,
    startNativeChildTurn,
    dispatchHarnessUserTurn,
    setHarnessSession,
    seedQueuedTurnBehindLiveTurn,
    settleLiveTurn,
  } = useProviderCommandReactorHarness({
    setScope: (next) => {
      scope = next;
    },
  });

  it("a fork mints fresh control state from the parent's live chat intent", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const parentId = ThreadId.makeUnsafe("thread-1");
    const childId = ThreadId.makeUnsafe("thread-fork-child");
    const orphanId = ThreadId.makeUnsafe("thread-fork-orphan");
    const harness = await createHarness({
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
      forkThreadResult: { threadId: childId, resumeCursor: { sessionId: "fork-child" } },
    });
    const createdAt = new Date().toISOString();
    const startOrdinaryTurn = (id: ThreadId, tag: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`computer-fork-turn-${tag}`),
          threadId: id,
          message: {
            messageId: asMessageId(`computer-fork-message-${tag}`),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }),
      );
    try {
      // Parent with live switch intent: the fork inherits it at generation 0.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("computer-fork-parent-chat"),
          threadId: parentId,
          message: {
            messageId: asMessageId("computer-fork-parent-message"),
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
      expect(manager.canContinueChatControl(parentId)).toBe(true);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("computer-fork-create"),
          threadId: childId,
          sourceThreadId: parentId,
          projectId: asProjectId("project-1"),
          title: "Fork child",
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
      await startOrdinaryTurn(childId, "child");
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.forkThread).toHaveBeenCalledTimes(1);
      expect(harness.forkThread.mock.calls[0]?.[0]).toMatchObject({
        sourceThreadId: parentId,
        enableComputerControl: true,
      });
      expect(manager.canContinueChatControl(childId)).toBe(true);
      // Parent intent revoked: a later fork starts without computer control.
      await manager.setControlEnabled(parentId, false);
      await manager.setControlEnabled(parentId, true);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.fork.create",
          commandId: CommandId.makeUnsafe("computer-fork-create-orphan"),
          threadId: orphanId,
          sourceThreadId: parentId,
          projectId: asProjectId("project-1"),
          title: "Fork orphan",
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
      await startOrdinaryTurn(orphanId, "orphan");
      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      expect(harness.forkThread).toHaveBeenCalledTimes(2);
      expect(harness.forkThread.mock.calls[1]?.[0]).toMatchObject({
        sourceThreadId: parentId,
        enableComputerControl: false,
      });
      expect(manager.canContinueChatControl(orphanId)).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it.each([false, true])(
    "Computer switch-on during live coding steering respects stale generation=%s",
    async (stale) => {
      const manager = new ComputerManager({ backend: new FakeComputerBackend() });
      const registry = makeAgentGatewaySessionRegistry();
      const threadId = ThreadId.makeUnsafe("thread-1");
      registry.issue(threadId, "codex");
      const harness = await createHarness({
        gatewaySessions: registry,
        computerService: {
          supported: true,
          availability: { kind: "available", backend: "fake" },
          manager,
        },
      });
      const createdAt = new Date().toISOString();
      try {
        if (stale) {
          await manager.setControlEnabled(threadId, false);
          await manager.setControlEnabled(threadId, true);
        }
        harness.setRuntimeSessionTurnState({
          threadId,
          status: "running",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("coding-live"),
        });
        await setHarnessSession(harness, {
          commandId: "coding-steer-session",
          threadId,
          status: "running",
          activeTurnId: asTurnId("coding-live"),
          at: createdAt,
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("coding-steer-activation"),
            threadId,
            message: {
              messageId: asMessageId("coding-steer-message"),
              role: "user",
              text: "Adjust the layout",
              attachments: [],
            },
            enableComputerControl: true,
            computerControlGeneration: 0,
            dispatchMode: "steer",
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        if (stale) {
          await waitFor(() => harness.steerTurn.mock.calls.length === 1);
          expect(harness.startSession).not.toHaveBeenCalled();
          expect(harness.interruptTurn).not.toHaveBeenCalled();
        } else {
          await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
          expect(harness.steerTurn).not.toHaveBeenCalled();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
          await harness.emitRuntimeEvent({
            type: "turn.completed",
            eventId: asEventId("coding-live-completed"),
            provider: "codex",
            threadId,
            createdAt,
            turnId: asTurnId("coding-live"),
            payload: { state: "completed" },
            providerRefs: {},
          } as ProviderRuntimeEvent);
          await waitFor(() => harness.sendTurn.mock.calls.length === 1);
          expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(true);
        }
      } finally {
        await manager.dispose();
      }
    },
  );

  it("preserves an active Computer profile during native steering after the switch turns off", async () => {
    const registry = makeAgentGatewaySessionRegistry();
    const threadId = ThreadId.makeUnsafe("thread-1");
    registry.issue(threadId, "codex", { additionalCapabilities: ["computer:control"] });
    const harness = await createHarness({ gatewaySessions: registry });
    const createdAt = new Date().toISOString();
    harness.setRuntimeSessionTurnState({
      threadId,
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: asTurnId("computer-live"),
    });
    await setHarnessSession(harness, {
      commandId: "computer-steer-session",
      threadId,
      status: "running",
      activeTurnId: asTurnId("computer-live"),
      at: createdAt,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("computer-steer"),
        threadId,
        message: {
          messageId: asMessageId("computer-steer-message"),
          role: "user",
          text: "Use the second window",
          attachments: [],
        },
        enableComputerControl: false,
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      }),
    );
    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("does not revive stale Computer consent when a durable queued turn is promoted after re-enable", async () => {
    const manager = new ComputerManager({ backend: new FakeComputerBackend() });
    const registry = makeAgentGatewaySessionRegistry();
    const threadId = ThreadId.makeUnsafe("thread-1");
    registry.issue(threadId, "codex", { additionalCapabilities: ["computer:control"] });
    const harness = await createHarness({
      gatewaySessions: registry,
      computerService: {
        supported: true,
        availability: { kind: "available", backend: "fake" },
        manager,
      },
    });
    const createdAt = new Date().toISOString();
    try {
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: asTurnId("computer-blocking"),
      });
      await setHarnessSession(harness, {
        commandId: "computer-queue-session",
        threadId,
        status: "running",
        activeTurnId: asTurnId("computer-blocking"),
        at: createdAt,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("computer-queued-consent"),
          threadId,
          message: {
            messageId: asMessageId("computer-queued-message"),
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
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      await manager.setControlEnabled(threadId, false);
      await manager.setControlEnabled(threadId, true);
      harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      await harness.emitRuntimeEvent({
        type: "turn.completed",
        eventId: asEventId("computer-blocking-completed"),
        provider: "codex",
        threadId,
        createdAt,
        turnId: asTurnId("computer-blocking"),
        payload: { state: "completed" },
        providerRefs: {},
      } as ProviderRuntimeEvent);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("checks computer capability against the live provider when the projection has no provider name", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const registry = makeAgentGatewaySessionRegistry();
    registry.issue(threadId, "codex", { additionalCapabilities: ["computer:control"] });
    const computerControlProvisioned = vi.fn(
      (id: string, provider: ProviderKind) =>
        registry.computerControlProvisioned?.(id, provider) ?? false,
    );
    const harness = await createHarness({
      gatewaySessions: { ...registry, computerControlProvisioned },
    });
    const now = new Date().toISOString();
    harness.setRuntimeSessionTurnState({
      threadId,
      status: "ready",
      runtimeMode: "approval-required",
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-missing-provider-name",
      threadId,
      status: "ready",
      providerName: null,
      at: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-live-computer-provider"),
        threadId,
        message: {
          messageId: asMessageId("user-live-computer-provider"),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        enableComputerControl: true,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(computerControlProvisioned).toHaveBeenCalledWith(threadId, "codex");
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.listSessions.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-goal-before-turn"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Deliver <all> providers safely",
        goalStartBehavior: "defer",
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-1",
      text: "hello reactor",
      createdAt: now,
      commandId: "cmd-turn-start-1",
    });

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
    const providerInput = harness.sendTurn.mock.calls[0]?.[0].input;
    expect(providerInput).toContain("<synara_goal>");
    expect(providerInput).toContain("Deliver &lt;all&gt; providers safely");
    expect(providerInput).toContain("</synara_goal>\n\nhello reactor");

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    // One scan rechecks the provider's live-turn race before dispatch; the
    // session ensure then performs the only full lookup needed for startup.
    expect(harness.listSessions).toHaveBeenCalledTimes(2);
  });

  it("preserves existing threads while a provider is disabled and resumes after re-enabling", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
      serverSettings: { providers: { opencode: { enabled: false } } },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-opencode-disabled",
      text: "try while disabled",
      createdAt: now,
      commandId: "cmd-turn-start-opencode-disabled",
    });

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const disabledThread = await readHarnessThread(harness);
    expect(disabledThread).toBeDefined();
    expect(disabledThread?.session?.lastError).toContain(
      "OpenCode is disabled in Settings > Providers",
    );
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.serverSettings.updateSettings({ providers: { opencode: { enabled: true } } }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-opencode-reenabled",
      text: "continue after re-enable",
      createdAt: now,
      commandId: "cmd-turn-start-opencode-reenabled",
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("continue after re-enable");
  });

  it("routes subagent-thread turn starts to the parent session as steers", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      ingestRuntimeEvents: true,
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-subagent-thread-create"),
        threadId: ThreadId.makeUnsafe("subagent:thread-1:tool-steer-1"),
        projectId: asProjectId("project-1"),
        title: "Subagent",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await startNativeChildTurn(harness, "tool-steer-1", "claudeAgent");

    await dispatchHarnessUserTurn(harness, {
      messageId: "subagent-steer-message-1",
      text: "focus on the tests",
      createdAt: now,
      threadId: ThreadId.makeUnsafe("subagent:thread-1:tool-steer-1"),
      commandId: "cmd-subagent-steer-1",
    });

    await waitFor(() => harness.steerSubagent.mock.calls.length === 1);
    expect(harness.steerSubagent.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      providerThreadId: "tool-steer-1",
      input: "focus on the tests",
    });
    // The subagent thread must never boot a provider session of its own.
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("injects the subagent thread goal into its parent-session steer", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      ingestRuntimeEvents: true,
    });
    const now = new Date().toISOString();
    const subagentThreadId = ThreadId.makeUnsafe("subagent:thread-1:tool-goal-steer");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-subagent-goal-thread-create"),
        threadId: subagentThreadId,
        projectId: asProjectId("project-1"),
        title: "Goal subagent",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
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
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-subagent-goal-set"),
        threadId: subagentThreadId,
        goal: "Finish <all> tests",
      }),
    );
    await startNativeChildTurn(harness, "tool-goal-steer", "claudeAgent");
    await dispatchHarnessUserTurn(harness, {
      messageId: "subagent-goal-steer-message",
      text: "continue",
      createdAt: now,
      threadId: subagentThreadId,
      commandId: "cmd-subagent-goal-steer",
    });

    await waitFor(() => harness.steerSubagent.mock.calls.length === 1);
    const steerInput = harness.steerSubagent.mock.calls[0]?.[0].input;
    expect(steerInput).toContain("<synara_goal>");
    expect(steerInput).toContain("Finish &lt;all&gt; tests");
    expect(steerInput).toContain("</synara_goal>\n\ncontinue");
  });

  it.each([
    [
      "adapter validation",
      () =>
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "turn/steerSubagent",
          issue: "This subagent has finished; its message was not sent.",
        }),
    ],
    [
      "inactive provider runtime",
      () =>
        new ProviderValidationError({
          operation: "ProviderService.steerSubagent",
          issue: "The provider runtime is not active.",
        }),
    ],
    ["missing provider session", () => new ProviderSessionNotFoundError({ threadId: "thread-1" })],
  ] as const)(
    "preserves a completed native child when its admitted steer is safely rejected by %s",
    async (_reason, rejectSteer) => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        ingestRuntimeEvents: true,
      });
      const now = new Date().toISOString();
      const providerThreadId = "late-child";
      const childThreadId = ThreadId.makeUnsafe(`subagent:thread-1:${providerThreadId}`);
      const { turnId } = await startNativeChildTurn(harness, providerThreadId, "claudeAgent");
      const enteredSteer = Deferred.makeUnsafe<void>();
      const releaseSteer = Deferred.makeUnsafe<void>();
      harness.steerSubagent.mockImplementationOnce(() =>
        Deferred.succeed(enteredSteer, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSteer)),
          Effect.andThen(Effect.fail(rejectSteer())),
        ),
      );

      const requested = await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-late-child-steer"),
          threadId: childThreadId,
          message: {
            messageId: asMessageId("late-child-message"),
            role: "user",
            text: "Follow up before you finish",
            attachments: [],
          },
          dispatchMode: "steer",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await Effect.runPromise(Deferred.await(enteredSteer));
      await harness.emitRuntimeEvent({
        type: "turn.completed",
        eventId: asEventId("evt-late-child-completed"),
        provider: "claudeAgent",
        createdAt: new Date().toISOString(),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        parentTurnId: asTurnId("turn-parent"),
        providerRefs: {
          providerThreadId,
          providerParentThreadId: "parent-provider-thread",
          providerTurnId: turnId,
          parentProviderTurnId: "turn-parent",
        },
        payload: { state: "completed" },
      });
      await waitFor(async () => {
        const child = await readHarnessThread(harness, childThreadId);
        return child?.latestTurn?.state === "completed" && child.session?.status === "ready";
      });
      await Effect.runPromise(Deferred.succeed(releaseSteer, undefined));
      await harness.drain();

      const child = await readHarnessThread(harness, childThreadId);
      expect(child?.latestTurn).toMatchObject({ turnId, state: "completed" });
      expect(child?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
      });
      expect(child?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "late-child-message", role: "user" }),
        ]),
      );
      expect(child?.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "provider.turn.start.failed",
            payload: expect.objectContaining({
              messageId: "late-child-message",
              detail: expect.stringContaining("message was not sent"),
            }),
          }),
        ]),
      );
      const delivery = await Effect.runPromise(
        harness.deliveryRepository.getDelivery({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: requested.sequence,
        }),
      );
      expect(Option.getOrThrow(delivery).state).toBe("succeeded");
      const blocker = await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId: childThreadId,
        }),
      );
      expect(Option.isNone(blocker)).toBe(true);
    },
  );

  const awaitThreadActivity = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    kind: string,
  ) => {
    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.activities.some((activity) => activity.kind === kind) ??
        false,
    );
    return (await readHarnessThread(harness))?.activities.find((activity) => activity.kind === kind)
      ?.payload;
  };

  it("appends a failure activity when a task stop is requested without an active session", async () => {
    const harness = await createHarness();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-no-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-orphan",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(await awaitThreadActivity(harness, "provider.task.stop.failed")).toMatchObject({
      detail: "No active provider session is bound to this thread.",
    });
    expect(harness.stopTask).not.toHaveBeenCalled();
  });

  it("surfaces terminal interrupt rejections as a thread activity", async () => {
    const harness = await createHarness();
    harness.interruptTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderValidationError({
          operation: "ProviderService.interruptTurn",
          issue:
            "Cannot interrupt thread 'thread-1' because no exact active provider turn is bound.",
        }),
      ),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-before-interrupt-rejection",
      commandId: "cmd-turn-before-interrupt-rejection",
      text: "work on something",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-interrupt-rejected"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    expect(await awaitThreadActivity(harness, "provider.turn.interrupt.failed")).toMatchObject({
      detail: expect.stringContaining("no exact active provider turn is bound"),
    });
  });

  it("surfaces provider task stop failures as a thread activity", async () => {
    const harness = await createHarness();
    harness.stopTask.mockImplementationOnce(() => Effect.die(new Error("task stop exploded")));

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-before-task-stop-failure",
      commandId: "cmd-turn-before-task-stop-failure",
      text: "spawn something",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.stop",
        commandId: CommandId.makeUnsafe("cmd-task-stop-failing"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        taskId: "task-stop-failing",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(await awaitThreadActivity(harness, "provider.task.stop.failed")).toMatchObject({
      detail: expect.stringContaining("task stop exploded"),
    });
    expect(harness.stopTask).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      taskId: "task-stop-failing",
    });
  });

  it("surfaces provider task background failures as a thread activity", async () => {
    const harness = await createHarness();
    harness.backgroundTask.mockImplementationOnce(() =>
      Effect.die(new Error("task background exploded")),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-before-task-background-failure",
      commandId: "cmd-turn-before-task-background-failure",
      text: "spawn something",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.task.background",
        commandId: CommandId.makeUnsafe("cmd-task-background-failing"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        toolUseId: "tool-task-bg-failing",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(await awaitThreadActivity(harness, "provider.task.background.failed")).toMatchObject({
      detail: expect.stringContaining("task background exploded"),
    });
    expect(harness.backgroundTask).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toolUseId: "tool-task-bg-failing",
    });
  });

  it("admits new threads while acknowledgement catch-up is blocked", async () => {
    const releaseCapture = Deferred.makeUnsafe<void>();
    const releaseAck = Deferred.makeUnsafe<void>();
    const ackStarted = Deferred.makeUnsafe<void>();
    const captureCheckpoint = vi.fn<CheckpointStoreShape["captureCheckpoint"]>(() =>
      Deferred.await(releaseCapture),
    );
    const harness = await createHarness({
      checkpointStore: {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint,
      },
    });
    const now = new Date().toISOString();
    const independent = Array.from({ length: 5 }, (_, index) =>
      ThreadId.makeUnsafe(`ack-independent-${index}`),
    );
    for (const [index, threadId] of independent.entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`ack-independent-create-${index}`),
          threadId,
          projectId: asProjectId("project-1"),
          title: "Independent",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    }
    await harness.drain();
    const start = (threadId: ThreadId, id: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`ack-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`ack-message-${id}`),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
    try {
      await start(ThreadId.makeUnsafe("thread-1"), "blocked");
      await waitFor(() => captureCheckpoint.mock.calls.length === 1);
      for (let index = 0; index < 40; index += 1) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`ack-tail-${index}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            activity: {
              id: EventId.makeUnsafe(`ack-tail-${index}`),
              kind: "tool.progress",
              tone: "info",
              summary: "Tool is running",
              payload: {},
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
      }
      const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
      const firstProgress = events.find(
        (event) =>
          event.type === "thread.activity-appended" && event.payload.activity.id === "ack-tail-0",
      )!;
      expect(firstProgress).toBeDefined();
      const advanceCursor = harness.deliveryRepository.advanceCursor;
      vi.spyOn(harness.deliveryRepository, "advanceCursor").mockImplementation((input) =>
        input.eventSequence === firstProgress.sequence
          ? Deferred.succeed(ackStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseAck)),
              Effect.andThen(advanceCursor(input)),
            )
          : advanceCursor(input),
      );
      await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
      await Effect.runPromise(Deferred.await(ackStarted).pipe(Effect.timeout("1 second")));
      const startedAt = Date.now();
      for (const [index, threadId] of independent.entries())
        await start(threadId, `independent-${index}`);
      await waitFor(
        () =>
          independent.every((threadId) =>
            harness.sendTurn.mock.calls.some(([input]) => input.threadId === threadId),
          ),
        500,
      );
      console.info(
        `Five independent provider turns delivered with acknowledgement catch-up blocked: ${Date.now() - startedAt}ms`,
      );
      const consumer = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
        ),
      );
      expect(consumer.lastAckedSequence).toBeLessThan(firstProgress.sequence);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
      await Effect.runPromise(Deferred.succeed(releaseAck, undefined));
      await harness.drain();
    }
  });

  it("bounds provider journal queries while resuming every intent past interleaved telemetry", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    await dispatchHarnessUserTurn(harness, {
      messageId: "bounded-provider-message",
      text: "hello",
      createdAt,
      threadId,
      commandId: "bounded-provider-turn",
    });
    await harness.drain();
    const globalReads = vi.spyOn(harness.engine, "readEventsThrough");
    const acknowledgementReads = vi.spyOn(harness.deliveryRepository, "readEventSequencePage");
    const threadReads = vi.spyOn(harness.engine, "readThreadEventsThrough");
    const release = Deferred.makeUnsafe<void>();
    harness.backgroundTask.mockImplementationOnce(() => Deferred.await(release));
    const background = (index: number) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.task.background",
          commandId: CommandId.makeUnsafe(`bounded-background-${index}`),
          threadId,
          toolUseId: `bounded-${index}`,
          createdAt,
        }),
      );
    try {
      await background(0);
      await waitFor(() => harness.backgroundTask.mock.calls.length === 1, 1_000);
      for (let index = 1; index <= 40; index++) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`bounded-telemetry-${index}`),
            threadId,
            activity: {
              id: EventId.makeUnsafe(`bounded-telemetry-${index}`),
              kind: "tool.progress",
              tone: "info",
              summary: "Working",
              payload: {},
              turnId: null,
              createdAt,
            },
            createdAt,
          }),
        );
        await background(index);
      }
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(harness.backgroundTask.mock.calls.map(([input]) => input.toolUseId)).toEqual(
        Array.from({ length: 41 }, (_, index) => `bounded-${index}`),
      );
      expect(globalReads).not.toHaveBeenCalled();
      expect(acknowledgementReads.mock.calls.length).toBeGreaterThan(0);
      expect(acknowledgementReads.mock.calls.every(([input]) => input.limit === 32)).toBe(true);
      expect(threadReads.mock.calls.some(([, , , , limit]) => limit === 32)).toBe(true);
      // A cached next head can remove the extra head-only query entirely.
      expect(threadReads.mock.calls.length).toBeLessThan(10);
      expect(
        threadReads.mock.calls.every(
          ([, , , types, limit]) =>
            limit !== undefined &&
            Number.isInteger(limit) &&
            limit >= 1 &&
            limit <= 32 &&
            types?.includes("thread.task-background-requested") &&
            !types.includes("thread.activity-appended"),
        ),
      ).toBe(true);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
    }
  });

  it("starts an unrelated thread while another thread's message checkpoint is blocked", async () => {
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureCheckpoint = vi
      .fn<CheckpointStoreShape["captureCheckpoint"]>(() => Effect.void)
      .mockImplementationOnce(() => Effect.promise(() => captureGate));
    const harness = await createHarness({
      // Keep the held checkpoint pending while the fixture writes its 600-event backlog.
      preTurnBaselineTimeout: Duration.minutes(1),
      checkpointStore: {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint,
      },
    });
    // Startup replay has settled; count stored acknowledgement rows, including gaps.
    const acknowledgementReadSizes: number[] = [];
    const readEventSequencePage = harness.deliveryRepository.readEventSequencePage;
    vi.spyOn(harness.deliveryRepository, "readEventSequencePage").mockImplementation((input) =>
      readEventSequencePage(input).pipe(
        Effect.tap((rows) => Effect.sync(() => acknowledgementReadSizes.push(rows.length))),
      ),
    );
    const now = new Date().toISOString();
    // An independent checkout can capture concurrently; the same physical checkout
    // intentionally shares the baseline/undo lease.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-isolated-create"),
        threadId: ThreadId.makeUnsafe("thread-isolated"),
        projectId: asProjectId("project-1"),
        title: "Independent",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        envMode: "worktree",
        worktreePath: "/tmp/provider-project-isolated",
        createdAt: now,
      }),
    );
    const start = (threadId: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-isolated-${threadId}`),
          threadId: ThreadId.makeUnsafe(threadId),
          message: {
            messageId: asMessageId(`message-isolated-${threadId}`),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
    try {
      await start("thread-1");
      await waitFor(() => captureCheckpoint.mock.calls.length > 0);
      // A tool/progress burst in the blocked lane must not consume provider
      // delivery admission: these events have no provider side effect.
      for (let index = 0; index < 300; index += 1) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`cmd-progress-${index}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            requireUnarchived: true,
            activity: {
              id: EventId.makeUnsafe(`progress-${index}`),
              kind: "tool.progress",
              tone: "info",
              summary: "Tool is running",
              payload: {},
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
      }
      // Real intents from one busy thread remain in its durable lane rather
      // than occupying every cross-thread admission slot.
      for (let index = 0; index < 300; index += 1) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.task.background",
            commandId: CommandId.makeUnsafe(`cmd-busy-intent-${index}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            toolUseId: `busy-tool-${index}`,
            createdAt: now,
          }),
        );
      }
      const independentStartedAt = Date.now();
      await start("thread-isolated");
      await waitFor(
        () => harness.sendTurn.mock.calls.some(([input]) => input.threadId === "thread-isolated"),
        500,
      );
      console.info(
        `Independent provider turn latency with a blocked checkpoint, 300 progress events and 300 queued intents: ${Date.now() - independentStartedAt}ms`,
      );
      expect(harness.sendTurn.mock.calls.some(([input]) => input.threadId === "thread-1")).toBe(
        false,
      );
      const events = Array.from(
        await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
      );
      const blocked = events.find(
        (event) =>
          event.type === "thread.turn-start-requested" && event.payload.threadId === "thread-1",
      )!;
      const independent = events.find(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.payload.threadId === "thread-isolated",
      )!;
      await waitFor(
        async () =>
          Option.getOrUndefined(
            await Effect.runPromise(
              harness.deliveryRepository.getDelivery({
                consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                eventSequence: independent.sequence,
              }),
            ),
          )?.state === "succeeded",
      );
      const consumer = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
        ),
      );
      expect(consumer.lastAckedSequence).toBeLessThan(blocked.sequence);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.task.background",
          commandId: CommandId.makeUnsafe("cmd-isolated-same-thread-follower"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          toolUseId: "fifo-follower",
          createdAt: now,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(harness.backgroundTask).not.toHaveBeenCalled();
    } finally {
      releaseCapture();
      await harness.drain();
    }
    await waitFor(() => harness.backgroundTask.mock.calls.length === 301);
    expect(harness.backgroundTask.mock.calls.map(([input]) => input.toolUseId)).toEqual([
      ...Array.from({ length: 300 }, (_, index) => `busy-tool-${index}`),
      "fifo-follower",
    ]);
    const blockedTurnIndex = harness.sendTurn.mock.calls.findIndex(
      ([input]) => input.threadId === "thread-1",
    );
    expect(harness.sendTurn.mock.invocationCallOrder[blockedTurnIndex]).toBeLessThan(
      harness.backgroundTask.mock.invocationCallOrder[0]!,
    );
    expect(acknowledgementReadSizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(300);
    expect(Math.max(...acknowledgementReadSizes)).toBeLessThanOrEqual(32);
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

  it.each(["git-and-studio-failed", "studio-failed", "not-applicable"] as const)(
    "reports real Hub preparation state when %s",
    async (mode) => {
      const studioRuntime = ManagedRuntime.make(
        HubOutputReactorLive.pipe(
          Layer.provide(
            Layer.succeed(ProviderService, {
              streamEvents: Stream.empty,
            } as unknown as ProviderServiceShape),
          ),
          Layer.provide(Layer.succeed(OrchestrationEngineService, {} as OrchestrationEngineShape)),
          Layer.provide(
            Layer.succeed(ProjectionSnapshotQuery, {
              getThreadShellById: () =>
                mode === "not-applicable"
                  ? Effect.succeed(Option.none())
                  : Effect.die(new Error("Hub workspace lookup failed")),
            } as never),
          ),
          Layer.provide(NodeServices.layer),
          Layer.provide(SqlitePersistenceMemory),
        ),
      );
      try {
        const studio = await studioRuntime.runPromise(Effect.service(HubOutputReactor));
        const harness = await createHarness({
          checkpointStore: {
            isGitRepository: () => Effect.succeed(true),
            captureCheckpoint: () =>
              mode === "studio-failed"
                ? Effect.void
                : Effect.fail(
                    new GitCommandError({
                      operation: "test.capture",
                      cwd: "/tmp/provider-project",
                      command: "git add",
                      detail: "Git capture failed",
                    }),
                  ),
            hasCheckpointRef: () => Effect.succeed(false),
          },
          hubOutputReactor: {
            captureBaselineBeforeTurn: (threadId) =>
              Effect.promise(() =>
                studioRuntime.runPromise(studio.captureBaselineBeforeTurn(threadId)),
              ),
            cancelPendingTurnBaseline: studio.cancelPendingTurnBaseline,
          },
        });
        await dispatchHarnessUserTurn(harness, {
          messageId: "both-baselines-failed",
          text: "Continue with truthful baseline feedback",
          createdAt: new Date().toISOString(),
        });
        await waitFor(() => harness.sendTurn.mock.calls.length === 1, 500);
        const notices = (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "checkpoint.baseline.skipped",
        );
        expect(notices).toHaveLength(1);
        expect(notices?.[0]?.payload).toMatchObject({
          checkpointBaseline: mode === "studio-failed" ? "captured" : "unavailable",
          studioPreparation: mode === "not-applicable" ? "not-applicable" : "unavailable",
          detail: expect.stringContaining(
            mode === "not-applicable" ? "not applicable" : "Hub workspace lookup failed",
          ),
        });
        expect(JSON.stringify(notices?.[0]?.payload)).not.toContain(
          "Completed Hub preparation is preserved",
        );
      } finally {
        await studioRuntime.dispose();
      }
    },
  );

  it.each(["git-failed", "not-git", "prepared"] as const)(
    "retains independently prepared Hub baseline when Git preparation is %s",
    async (mode) => {
      let studioPrepared = false;
      const harness = await createHarness({
        checkpointStore: {
          isGitRepository: () => Effect.succeed(mode !== "not-git"),
          captureCheckpoint: () =>
            mode === "git-failed"
              ? Effect.fail(
                  new GitCommandError({
                    operation: "test.capture",
                    cwd: "/tmp/provider-project",
                    command: "git add",
                    detail: "Capture failed",
                  }),
                )
              : Effect.void,
        },
        hubOutputReactor: {
          captureBaselineBeforeTurn: () =>
            Effect.sync(() => {
              studioPrepared = true;
              return { status: "completed" as const };
            }),
          cancelPendingTurnBaseline: () =>
            Effect.sync(() => {
              studioPrepared = false;
            }),
        },
      });
      let preparedAtSend = false;
      const send = harness.sendTurn.getMockImplementation()!;
      harness.sendTurn.mockImplementationOnce((input) => {
        preparedAtSend = studioPrepared;
        return send(input);
      });
      await dispatchHarnessUserTurn(harness, {
        messageId: `independent-baseline-${mode}`,
        text: "Use independent preparation",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1, 500);
      expect(preparedAtSend).toBe(true);
      expect(studioPrepared).toBe(true);
      const skipped = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "checkpoint.baseline.skipped",
      );
      expect(skipped).toHaveLength(mode === "git-failed" ? 1 : 0);
    },
  );

  it.each(["git", "studio"] as const)(
    "continues after a slow %s baseline deadline only after capture cleanup",
    async (kind) => {
      let cleanedUp = false;
      let captureStarted = false;
      let studioCleared = false;
      let checkpointPrepared = false;
      const release = Deferred.makeUnsafe<void>();
      const hungCapture = Effect.sync(() => {
        captureStarted = true;
      }).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.onInterrupt(() =>
          Effect.sleep("20 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                cleanedUp = true;
              }),
            ),
          ),
        ),
      );
      vi.stubEnv("SYNARA_PRE_TURN_BASELINE_TIMEOUT_MS", "15000");
      const harness = await createHarness({
        preTurnBaselineTimeout: Duration.millis(30),
        hubOutputReactor: {
          captureBaselineBeforeTurn: () =>
            (kind === "studio" ? hungCapture : Effect.void).pipe(
              Effect.as({ status: "completed" as const }),
            ),
          cancelPendingTurnBaseline: () =>
            Effect.sync(() => {
              studioCleared = true;
            }),
        },
        checkpointStore: {
          isGitRepository: () => Effect.succeed(true),
          captureCheckpoint: () =>
            kind === "git"
              ? hungCapture
              : Effect.sync(() => {
                  checkpointPrepared = true;
                }),
        },
      });
      let cleanedUpAtSend = false;
      const send = harness.sendTurn.getMockImplementation()!;
      harness.sendTurn.mockImplementationOnce((input) => {
        cleanedUpAtSend = cleanedUp;
        return send(input);
      });
      await dispatchHarnessUserTurn(harness, {
        messageId: `baseline-deadline-${kind}`,
        text: "Continue after a bounded baseline",
        createdAt: new Date().toISOString(),
      });
      try {
        await waitFor(() => captureStarted, 500);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(cleanedUpAtSend).toBe(true);
        expect(cleanedUp).toBe(true);
        expect(studioCleared).toBe(kind === "studio");
        expect(checkpointPrepared).toBe(kind === "studio");
        expect((await readHarnessThread(harness))?.activities).toContainEqual(
          expect.objectContaining({
            kind: "checkpoint.baseline.skipped",
            tone: "info",
            payload: expect.objectContaining({
              detail: expect.stringContaining(
                kind === "studio" ? "independently prepared checkpoint is preserved" : "undo",
              ),
              checkpointBaseline: kind === "studio" ? "captured" : "unavailable",
            }),
          }),
        );
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["send", "review"] as const)(
    "waits for workspace restore before %s even after the baseline deadline",
    async (mode) => {
      const harness = await createHarness({
        preTurnBaselineTimeout: Duration.millis(30),
        checkpointStore: { isGitRepository: () => Effect.succeed(true) },
      });
      const acquired = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const restore = Effect.runFork(
        harness.checkpointCoordinator.withWorkspaceLease(
          "/tmp/provider-project",
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      await Effect.runPromise(Deferred.await(acquired));
      try {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`restore-gate-${mode}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            message: {
              messageId: MessageId.makeUnsafe(`restore-gate-message-${mode}`),
              role: "user",
              text: "Start after restore",
              attachments: [],
            },
            ...(mode === "review" ? { reviewTarget: { type: "uncommittedChanges" as const } } : {}),
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(
          async () =>
            (await readHarnessThread(harness))?.activities.some(
              (activity) => activity.kind === "checkpoint.baseline.skipped",
            ) ?? false,
        );
        const dispatch = mode === "review" ? harness.startReview : harness.sendTurn;
        expect(dispatch).not.toHaveBeenCalled();
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await waitFor(() => dispatch.mock.calls.length === 1);
        await harness.drain();
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await Effect.runPromise(Effect.exit(Fiber.join(restore)));
      }
    },
  );

  it("does not report a missing baseline when capture publishes during timeout cleanup", async () => {
    const release = Deferred.makeUnsafe<void>();
    let published = false;
    let cleanupFinished = false;
    let studioCleared = false;
    const harness = await createHarness({
      preTurnBaselineTimeout: Duration.millis(30),
      checkpointStore: {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () =>
          Deferred.await(release).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                published = true;
                cleanupFinished = true;
              }),
            ),
          ),
        hasCheckpointRef: () => Effect.sync(() => published),
      },
      hubOutputReactor: {
        captureBaselineBeforeTurn: () => Effect.succeed({ status: "completed" as const }),
        cancelPendingTurnBaseline: () =>
          Effect.sync(() => {
            studioCleared = true;
          }),
      },
    });
    try {
      await dispatchHarnessUserTurn(harness, {
        messageId: "published-on-cleanup",
        text: "Continue safely",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1, 500);
      expect(cleanupFinished).toBe(true);
      expect(published).toBe(true);
      expect(studioCleared).toBe(false);
      expect(
        (await readHarnessThread(harness))?.activities.filter(
          (activity) => activity.kind === "checkpoint.baseline.skipped",
        ),
      ).toEqual([]);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
  });

  it("keeps one combined skipped notice when both baseline owners time out", async () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = await createHarness({
      preTurnBaselineTimeout: Duration.millis(30),
      checkpointStore: {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Deferred.await(release),
        hasCheckpointRef: () => Effect.succeed(false),
      },
      hubOutputReactor: {
        captureBaselineBeforeTurn: () =>
          Deferred.await(release).pipe(Effect.as({ status: "completed" as const })),
      },
    });
    try {
      await dispatchHarnessUserTurn(harness, {
        messageId: "both-owner-timeout",
        text: "Continue without snapshots",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1, 500);
      const notices = (await readHarnessThread(harness))?.activities.filter(
        (activity) => activity.kind === "checkpoint.baseline.skipped",
      );
      expect(notices).toHaveLength(1);
      expect(notices?.[0]?.payload).toMatchObject({ detail: expect.stringContaining("Hub") });
      expect(notices?.[0]?.payload).toMatchObject({
        detail: expect.stringContaining("checkpoint"),
      });
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
  });

  it("waits for the Hub output baseline before sending the provider turn", async () => {
    let releaseCapture: (() => void) | undefined;
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureBaselineBeforeTurn = vi.fn<HubOutputReactorShape["captureBaselineBeforeTurn"]>(
      () => Effect.promise(() => captureGate).pipe(Effect.as({ status: "completed" as const })),
    );
    const harness = await createHarness({
      hubOutputReactor: { captureBaselineBeforeTurn },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-slow-studio-baseline",
      text: "create an output immediately",
      createdAt: now,
      commandId: "cmd-turn-start-slow-studio-baseline",
    });

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
    harness.startSession.mockImplementationOnce((threadId, input) =>
      Effect.promise(() => startSessionGate).pipe(
        Effect.flatMap(() => defaultStartSession(threadId, input)),
      ),
    );

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-early-status",
      text: "hello reactor",
      createdAt: now,
      commandId: "cmd-turn-start-early-status",
    });

    // The slow-provider window: status is already "starting" while init blocks.
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "starting");
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    releaseStartSession?.();
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const status = (await readHarnessThread(harness))?.session?.status;
      return status !== undefined && status !== "starting";
    });
  });

  const claudeStaleResumeFailure = () =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "turn/setModel",
        detail:
          "Claude Code returned an error result: No conversation found with session ID: b469168a-2625-4447-927f-d86d94bb7237",
      }),
    );

  it("retries Debug turns with transcript context without duplicating the prompt prefix", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    // Both the original send and the native-resume retry fail stale, so the
    // reactor falls back to the transcript bootstrap.
    harness.sendTurn
      .mockImplementationOnce(claudeStaleResumeFailure)
      .mockImplementationOnce(claudeStaleResumeFailure);

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
        interactionMode: "debug",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    // Native-resume retry first: stop only the runtime so the persisted cursor survives.
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    const nativeRetrySendInput = harness.sendTurn.mock.calls[1]?.[0] as {
      readonly input?: string;
    };
    expect(nativeRetrySendInput.input).not.toContain("<thread_context>");
    expect(nativeRetrySendInput.input?.split(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)).toHaveLength(2);
    // Second stale failure clears the cursor and bootstraps the transcript.
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.startSession.mock.calls.length).toBe(3);
    const retryStartInput = harness.startSession.mock.calls[2]?.[1];
    expect(retryStartInput).not.toHaveProperty("resumeCursor");

    const retrySendInput = harness.sendTurn.mock.calls[2]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).toContain("<thread_context>");
    expect(retrySendInput.input).toContain("Move the changelog navigation to the left.");
    expect(retrySendInput.input).toContain("<latest_user_message>");
    expect(retrySendInput.input).toContain("nice but bring it on the left.");
    expect(retrySendInput.input?.split(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)).toHaveLength(2);
  });

  it("keeps transcript context when replaying a stale Claude goal continuation", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.sendTurn
      .mockImplementationOnce(claudeStaleResumeFailure)
      .mockImplementationOnce(claudeStaleResumeFailure);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-goal-continuation-history"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId("user-message-before-goal-continuation"),
            role: "user",
            text: "Implement the persistence layer first.",
            createdAt: now,
            updatedAt: now,
          },
          {
            messageId: asMessageId("assistant-message-before-goal-continuation"),
            role: "assistant",
            text: "The persistence layer is complete.",
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-stale-continuation-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: "Finish the remaining goal work",
        goalStartBehavior: "defer",
      }),
    );
    const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt;
    expect(goalStartedAt).toBeTruthy();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-stale-goal-continuation-retry"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goalStartedAt: goalStartedAt!,
        trigger: "turn-completed",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    const retrySendInput = harness.sendTurn.mock.calls[2]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).toContain("<thread_context>");
    expect(retrySendInput.input).toContain("Implement the persistence layer first.");
    expect(retrySendInput.input).toContain("The persistence layer is complete.");
    expect(retrySendInput.input).toContain("Finish the remaining goal work");
    expect(retrySendInput.input).toContain("Continue working toward the active thread goal");
  });

  it("retries a stale Claude resume natively before paying the transcript bootstrap", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(claudeStaleResumeFailure);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-native-resume-retry"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-native-resume-retry"),
          role: "user",
          text: "keep going.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    // The session restarts once with the persisted cursor intact...
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.startSession.mock.calls.length).toBe(2);
    // ...and the retry succeeds natively: no cursor clear, no bootstrap replay.
    expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    const retrySendInput = harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string };
    expect(retrySendInput.input).not.toContain("<thread_context>");
    expect(retrySendInput.input).toContain("keep going.");
  });

  it("skips the native resume retry when background tasks keep the runtime alive", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
    });
    const now = new Date().toISOString();
    harness.hasLiveRuntimeTasks.mockImplementation(() => Effect.succeed(true));
    harness.sendTurn.mockImplementationOnce(claudeStaleResumeFailure);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-stale-live-tasks"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-stale-live-tasks"),
          role: "user",
          text: "keep going.",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-8" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    // Live background tasks own the runtime subprocess: the retry must not
    // stop it, and recovery goes straight to the transcript bootstrap.
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      preserveActiveRuntime: true,
    });
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

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.status).toBe("error");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("turn start failed");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
    expect(harness.cancelPendingStudioOutputBaseline).toHaveBeenCalledWith(
      ThreadId.makeUnsafe("thread-1"),
    );
    await waitFor(async () => {
      const delivery = await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: "provider-command-reactor.v1",
          threadId: "thread-1",
        }),
      );
      return Option.isSome(delivery) && delivery.value.state === "uncertain";
    });
    const deliveryBlocker = await Effect.runPromise(
      harness.deliveryRepository.firstBlockingDeliveryForThread({
        consumerName: "provider-command-reactor.v1",
        threadId: "thread-1",
      }),
    );
    expect(deliveryBlocker.pipe(Option.getOrThrow)).toMatchObject({
      state: "uncertain",
      attemptCount: 1,
    });
  });

  it("surfaces a timed-out fresh turn start instead of leaving the thread starting", async () => {
    const harness = await createHarness({
      commandEventTimeout: Duration.millis(25),
    });
    const now = new Date().toISOString();
    harness.startSession.mockImplementationOnce(() => Effect.never);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-times-out"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-start-times-out"),
          role: "user",
          text: "hello stalled provider",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
    const thread = await readHarnessThread(harness);
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toContain("did not respond within 25ms");
    await waitFor(async () =>
      Boolean(
        (await readHarnessThread(harness))?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.start.failed" &&
            (activity.payload as Record<string, unknown> | null)?.settlementStatus === "uncertain",
        ),
      ),
    );
  });

  it.each([
    {
      provider: "codex",
      model: "gpt-5-codex",
      label: "the shared Home container",
      dedicated: false,
    },
    {
      provider: "pi",
      model: "openai/gpt-4o",
      label: "the shared Home container",
      dedicated: false,
    },
    { provider: "pi", model: "openai/gpt-4o", label: "a dedicated chat folder", dedicated: true },
  ] as const)(
    "starts $provider with the correct working directory for $label",
    async ({ provider, model, dedicated }) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      const { chatWorkspaceRoot } = await harness.runtime.runPromise(ServerConfig.asEffect());
      const workspaceRoot = dedicated
        ? path.join(chatWorkspaceRoot, "2026-11-17", "pi-example")
        : chatWorkspaceRoot;
      const modelSelection = { provider, model } as const;

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-home-project-create"),
          projectId: asProjectId("project-home"),
          kind: "chat",
          title: "Home",
          workspaceRoot,
          defaultModelSelection: modelSelection,
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
          modelSelection,
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
        modelSelection,
        runtimeMode: "approval-required",
      });
      expect(harness.startSession.mock.calls[0]?.[1]?.cwd).toBe(
        dedicated ? workspaceRoot : undefined,
      );
    },
  );

  it("keeps a manual rename made during automatic first-turn title generation", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    let finishTitleWrite!: () => void;
    const titleWriteFinished = new Promise<void>((resolve) => {
      finishTitleWrite = resolve;
    });
    const dispatch = harness.engine.dispatch;
    harness.interceptEngineDispatch((command) => {
      if (command.type === "thread.meta.update" && command.title === "Late automatic title") {
        return dispatch(command).pipe(Effect.onExit(() => Effect.sync(finishTitleWrite)));
      }
      return undefined;
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-initial-placeholder"),
        threadId,
        title: "New thread",
      }),
    );
    harness.generateThreadTitle.mockImplementationOnce(() =>
      harness.engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-manual-during-auto-title"),
          threadId,
          title: "Manual title wins",
        })
        .pipe(Effect.orDie, Effect.as({ title: "Late automatic title" })),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-auto-title-race"),
        threadId,
        message: {
          messageId: asMessageId("auto-title-race-user"),
          role: "user",
          text: "Fix startup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();
    await titleWriteFinished;
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect((await readHarnessThread(harness))?.title).toBe("Manual title wins");
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
    await waitFor(
      async () => (await readHarnessThread(harness))?.title === "Provider startup failures",
    );
  });

  it("does not reuse stale provider options when the configured title fallback is gone", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        instanceId: "antigravity",
        model: "auto-gemini-3",
      },
      serverSettings: {
        textGenerationModelSelection: {
          instanceId: "codex_removed_textgen",
          model: "gpt-5-codex",
        },
        providers: {
          codex: { enabled: false },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          antigravity: { enabled: false },
          opencode: { enabled: false },
          droid: { enabled: false },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-missing-fallback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-missing-fallback-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-fallback-title-1"),
          role: "user",
          text: "Summarize provider startup failures without Codex",
          attachments: [],
        },
        modelSelection: {
          provider: "antigravity",
          instanceId: "antigravity",
          model: "auto-gemini-3",
        },
        providerOptions: {
          codex: {
            homePath: "/tmp/stale-codex-home",
            environment: {
              STALE_CODEX_ENV: "must-not-leak",
            },
          },
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
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
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

    await waitFor(
      async () =>
        (await readHarnessThread(harness))?.title ===
        "Summarize provider startup failures without Codex",
    );
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
  });

  it("merges live provider instance options before first-turn title generation", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "opencode",
        instanceId: "opencode_work",
        model: "openai/gpt-5",
      },
      serverSettings: {
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            environment: [
              { name: "OPENCODE_API_KEY", value: "live-opencode-key", sensitive: true },
            ],
            config: {
              serverUrl: "http://127.0.0.1:5099",
              serverPassword: "live-opencode-password",
            },
          },
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
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-opencode-title-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "opencode",
          providerInstanceId: "opencode_work",
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
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-opencode-live-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "New thread",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-opencode-live-options-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-opencode-live-options-title-1"),
          role: "user",
          text: "Plan the release workflow and deployment checklist",
          attachments: [],
        },
        modelSelection: {
          provider: "opencode",
          instanceId: "opencode_work",
          model: "openai/gpt-5",
        },
        providerOptions: {
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "stale-opencode-password",
            environment: {
              OPENCODE_API_KEY: "stale-opencode-key",
            },
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: {
        opencode: {
          serverUrl: "http://127.0.0.1:5099",
          serverPassword: "live-opencode-password",
          environment: {
            OPENCODE_API_KEY: "live-opencode-key",
          },
        },
      },
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
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-worktree-rename",
      messageId: "user-message-worktree-rename",
      text: "The app crashes during startup, fix it",
      createdAt: now,
    });

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(() => harness.publishBranch.mock.calls.length === 1);

    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      },
    });

    await waitFor(async () => {
      const thread = await readHarnessThread(harness);
      return (
        thread?.branch === "synara/app-startup-crash" &&
        thread.associatedWorktreeBranch === "synara/app-startup-crash" &&
        thread.associatedWorktreeRef === "synara/app-startup-crash"
      );
    });

    const thread = await readHarnessThread(harness);
    expect(thread).toMatchObject({
      branch: "synara/app-startup-crash",
      worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
      associatedWorktreeBranch: "synara/app-startup-crash",
      associatedWorktreeRef: "synara/app-startup-crash",
    });
  });

  it("shares one gateway completion wait and timeout warning per creating operation", async () => {
    const operationId = "gateway-shared-timeout";
    const messages: string[] = [];
    const harness = await createHarness({
      gatewayOperationId: operationId,
      gatewayOperationCompletionWaitTimeout: Duration.millis(100),
      logMessages: messages,
    });
    harness.generateBranchName.mockImplementation(() => Effect.succeed({ branch: "renamed" }));
    await harness.reserveGatewayOperation(operationId);
    await harness.markGatewayOperationDispatching(operationId);
    const createdAt = new Date().toISOString();
    const other = ThreadId.makeUnsafe("gateway-other-thread");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("gateway-other-create"),
        threadId: other,
        projectId: asProjectId("project-1"),
        title: "Other gateway child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        creationSource: "synara_mcp",
        gatewayOperationId: operationId,
        gatewayOperationIndex: 1,
        createdAt,
      }),
    );
    for (const [index, threadId] of [ThreadId.makeUnsafe("thread-1"), other].entries()) {
      const branch = index === 0 ? "synara/cb661f0d" : "synara/cb661f0e";
      const cwd = `/tmp/provider-project/.worktrees/${branch.slice(7)}`;
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`gateway-other-meta-${index}`),
          threadId,
          envMode: "worktree",
          branch,
          worktreePath: cwd,
          associatedWorktreePath: cwd,
          associatedWorktreeBranch: branch,
          associatedWorktreeRef: branch,
        }),
      );
      await dispatchHarnessUserTurn(harness, {
        threadId,
        messageId: `gateway-shared-message-${index}`,
        text: "Rename this child",
        createdAt,
      });
    }
    try {
      await waitFor(() => harness.generateBranchName.mock.calls.length === 2, 500);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(
        messages.filter((message) =>
          message.includes("timed out waiting for creating gateway operation"),
        ),
      ).toHaveLength(1);
      expect(harness.renameBranch).not.toHaveBeenCalled();
    } finally {
      await harness.completeGatewayOperation(operationId);
    }
  });

  it("retries a completed gateway operation after its negative cache expires", async () => {
    const operationId = "gateway-negative-cache-expiry";
    const messages: string[] = [];
    const harness = await createHarness({
      gatewayOperationId: operationId,
      gatewayOperationCompletionWaitTimeout: Duration.millis(30),
      gatewayOperationCompletionNegativeCacheTtl: Duration.millis(30),
      logMessages: messages,
    });
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({ branch: "retry-after-completion" }),
    );
    await harness.reserveGatewayOperation(operationId);
    await harness.markGatewayOperationDispatching(operationId);
    const createdAt = new Date().toISOString();
    const startChild = async (threadId: ThreadId, index: number) => {
      if (index > 0)
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`negative-cache-child-${index}`),
            threadId,
            projectId: asProjectId("project-1"),
            title: "Gateway child",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            creationSource: "synara_mcp",
            gatewayOperationId: operationId,
            gatewayOperationIndex: index,
            branch: null,
            worktreePath: null,
            createdAt,
          }),
        );
      const branch = index === 0 ? "synara/cb661f0d" : "synara/cb661f0e";
      const cwd = `/tmp/provider-project/.worktrees/${branch.slice(7)}`;
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`negative-cache-meta-${index}`),
          threadId,
          envMode: "worktree",
          branch,
          worktreePath: cwd,
          associatedWorktreePath: cwd,
          associatedWorktreeBranch: branch,
          associatedWorktreeRef: branch,
        }),
      );
      await dispatchHarnessUserTurn(harness, {
        threadId,
        messageId: `negative-cache-message-${index}`,
        text: "Rename gateway child",
        createdAt,
      });
    };
    try {
      await startChild(ThreadId.makeUnsafe("thread-1"), 0);
      await waitFor(
        () =>
          messages.some((message) =>
            message.includes("timed out waiting for creating gateway operation"),
          ),
        500,
      );
      expect(harness.renameBranch).not.toHaveBeenCalled();
      await harness.completeGatewayOperation(operationId);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await startChild(ThreadId.makeUnsafe("gateway-retry-child"), 1);
      await waitFor(() => harness.renameBranch.mock.calls.length === 1, 500);
      await waitFor(
        async () =>
          (await readHarnessThread(harness, ThreadId.makeUnsafe("gateway-retry-child")))?.branch ===
          "synara/retry-after-completion",
        500,
      );
      expect(
        (await readHarnessThread(harness, ThreadId.makeUnsafe("gateway-retry-child")))?.branch,
      ).toBe("synara/retry-after-completion");
      expect(
        messages.filter((message) =>
          message.includes("timed out waiting for creating gateway operation"),
        ),
      ).toHaveLength(1);
    } finally {
      await harness.completeGatewayOperation(operationId);
    }
  });

  it("releases the repository lock and updates metadata while automatic publication is stalled", async () => {
    const harness = await createHarness();
    const publishGate = await Effect.runPromise(Deferred.make<void>());
    let publicationSettled = false;
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({ branch: "slow-publication" }),
    );
    harness.publishBranch.mockImplementation(() =>
      Deferred.await(publishGate).pipe(
        Effect.andThen(
          Effect.fail(
            new GitCommandError({
              operation: "GitCore.publishBranch",
              command: "git push",
              cwd: "/tmp/provider-project/.worktrees/slow",
              detail: "git push timed out",
            }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            publicationSettled = true;
          }),
        ),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-slow-publication-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/slow",
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-slow-publication-turn",
      messageId: "user-message-slow-publication",
      text: "Fix slow worktree creation",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.publishBranch.mock.calls.length === 1);
    let localMutationCompleted = false;
    const localMutation = Effect.runPromise(
      harness.withMutation(
        "/tmp/provider-project",
        Effect.sync(() => {
          localMutationCompleted = true;
        }),
      ),
    );
    try {
      await waitFor(() => localMutationCompleted);
      await waitFor(async () => {
        const thread = await readHarnessThread(harness);
        return (
          thread?.branch === "synara/slow-publication" &&
          thread.associatedWorktreeBranch === "synara/slow-publication"
        );
      });
      expect(publicationSettled).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(publishGate, undefined));
      await localMutation;
    }
    await waitFor(() => publicationSettled);
    expect((await readHarnessThread(harness))?.branch).toBe("synara/slow-publication");
  });

  it("waits for gateway operation completion before renaming its temporary branch", async () => {
    const operationId = "gateway-operation-worktree-rename";
    const harness = await createHarness({ gatewayOperationId: operationId });
    const now = new Date().toISOString();
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({ branch: "gateway-worktree-rename" }),
    );
    await harness.reserveGatewayOperation(operationId);
    await harness.markGatewayOperationDispatching(operationId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-gateway-worktree-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-gateway-turn-start-worktree-rename",
      messageId: "user-message-gateway-worktree-rename",
      text: "Rename this gateway worktree",
      createdAt: now,
    });

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    expect(harness.renameBranch).not.toHaveBeenCalled();

    await harness.completeGatewayOperation(operationId);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    await waitFor(() => harness.publishBranch.mock.calls.length === 1);
  });

  it("does not rename a gateway branch when the operation record is missing", async () => {
    const harness = await createHarness({ gatewayOperationId: "missing-gateway-operation" });
    const now = new Date().toISOString();
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({ branch: "must-not-be-used" }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-missing-gateway-worktree-bootstrap"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        envMode: "worktree",
        branch: "synara/cb661f0d",
        worktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreePath: "/tmp/provider-project/.worktrees/cb661f0d",
        associatedWorktreeBranch: "synara/cb661f0d",
        associatedWorktreeRef: "synara/cb661f0d",
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-missing-gateway-turn-start-worktree-rename",
      messageId: "user-message-missing-gateway-worktree-rename",
      text: "Do not rename this worktree",
      createdAt: now,
    });

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.renameBranch).not.toHaveBeenCalled();
    expect(harness.publishBranch).not.toHaveBeenCalled();
  });

  it("keeps the temporary worktree branch when no Git-writing generator is available", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
      gitWritingModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-8",
      },
      serverSettings: {
        providers: {
          codex: { enabled: false },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          opencode: { enabled: false },
          droid: { enabled: false },
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-keep-temporary"),
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
        commandId: CommandId.makeUnsafe("cmd-turn-start-worktree-keep-temporary"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-worktree-keep-temporary"),
          role: "user",
          text: "This entire message must never become the branch name",
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

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.renameBranch).not.toHaveBeenCalled();
    expect(harness.publishBranch).not.toHaveBeenCalled();

    const thread = await readHarnessThread(harness);
    expect(thread).toMatchObject({
      branch: "synara/cb661f0d",
      associatedWorktreeBranch: "synara/cb661f0d",
      associatedWorktreeRef: "synara/cb661f0d",
    });
  });

  it.each([
    { manualTitle: null, extraMessages: 0 },
    { manualTitle: "New thread", extraMessages: 0 },
    { manualTitle: "Investigate why the server stops responding", extraMessages: 0 },
    { manualTitle: null, extraMessages: 2_001 },
  ])(
    "keeps first-send naming ownership during replay ($manualTitle, $extraMessages)",
    async ({ manualTitle, extraMessages }) => {
      const harness = await createHarness({ startReactor: false });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const firstPrompt = "Investigate why the server stops responding";
      const now = new Date().toISOString();
      harness.generateThreadTitle.mockImplementation(() =>
        Effect.succeed({ title: "Server recovery" }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("title-backlog-placeholder"),
          threadId,
          title: extraMessages > 0 ? "New thread" : firstPrompt,
        }),
      );
      // A restart can replay the first send after later user messages are durable.
      // Eligibility belongs to the first message, not the current message count.
      for (const [index, text] of [firstPrompt, "Please preserve the current UI"].entries()) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`title-backlog-send-${index}`),
            threadId,
            message: {
              messageId: asMessageId(`title-backlog-message-${index}`),
              role: "user",
              text,
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          }),
        );
      }
      expect(
        (await readHarnessThread(harness))?.messages.filter((message) => message.role === "user"),
      ).toHaveLength(2);
      if (manualTitle !== null) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("title-backlog-manual"),
            threadId,
            title: manualTitle,
          }),
        );
      }
      if (extraMessages > 0) {
        // Fill the real projection window with later narration without creating provider calls.
        // The first durable user send must still own naming after it falls outside that window.
        await harness.persistWithoutLivePublication(
          Array.from({ length: extraMessages }, (_, index) => ({
            eventId: asEventId(`title-backlog-narration-${index}`),
            aggregateKind: "thread" as const,
            aggregateId: threadId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent" as const,
            payload: {
              threadId,
              messageId: asMessageId(`title-backlog-narration-${index}`),
              role: "assistant" as const,
              text: "Working",
              turnId: null,
              streaming: false,
              source: "native" as const,
              createdAt: now,
              updatedAt: now,
            },
          })),
        );
        const detail = await Effect.runPromise(
          harness.projectionSnapshotQuery.getThreadDetailById(threadId),
        );
        expect(
          Option.getOrThrow(detail).messages.some(
            (message) => message.id === asMessageId("title-backlog-message-0"),
          ),
        ).toBe(false);
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("title-window-later-send"),
            threadId,
            message: {
              messageId: asMessageId("title-window-later-message"),
              role: "user",
              text: "A later prompt must not own first naming",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: now,
          }),
        );
      }
      await harness.startReactor();
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalled();
      if (manualTitle !== null) {
        expect(harness.generateThreadTitle).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.title).toBe(manualTitle);
      } else {
        // Turn start reads the sent message by id (#1900), not from the newest
        // 2000-message detail window, so the replayed first send still starts
        // its turn and owns naming. The later prompt never does.
        await waitFor(async () => (await readHarnessThread(harness))?.title === "Server recovery");
        expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
        expect(harness.generateThreadTitle.mock.calls[0]?.[0].message).toBe(firstPrompt);
      }
    },
  );

  it("preserves a manual generic title assigned before the first queued send is promoted", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = asMessageId("title-first-queued");
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("title-queue-active"),
      messageId,
      text: "Name the first queued message",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("title-queue-manual"),
        threadId,
        title: "New thread",
      }),
    );
    const now = new Date().toISOString();
    const thread = await readHarnessThread(harness);
    harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("title-queue-ready"),
        threadId,
        session: { ...thread!.session!, status: "ready", activeTurnId: null, updatedAt: now },
        createdAt: now,
      }),
    );
    // Promotion is a new start event for the old message; it must not move the naming fence.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.dispatch-queued",
        commandId: CommandId.makeUnsafe("title-queue-promote"),
        threadId,
        messageId,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.startReactor();
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness))?.title).toBe("New thread");
  });

  it("drains a thread again after a promotion dispatch failed", async () => {
    const harness = await createHarness();
    const queuedSequence = await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-blocked"),
      messageId: asMessageId("msg-queue-blocked"),
      text: "promote me on the next settle",
    });

    // A checkpoint revert in flight blocks promotion and is deliberately not
    // retried — it clears through its own completion path. The failed drain
    // must still release its per-thread in-flight guard, or every later
    // terminal event for the thread would be ignored for the process lifetime.
    let refusals = 0;
    harness.interceptEngineDispatch((command) => {
      if (command.type !== "thread.turn.dispatch-queued" || refusals > 0) {
        return undefined;
      }
      refusals += 1;
      return Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread has a checkpoint revert in progress.",
        }),
      );
    });

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-blocked"),
      eventId: "evt-turn-completed-blocked",
    });
    await waitFor(() => refusals === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-blocked-later"),
      eventId: "evt-turn-completed-blocked-later",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "promote me on the next settle",
    });
    const promotion = await Effect.runPromise(
      harness.queuedTurnPromotionRepository.getBySequence(queuedSequence),
    );
    expect(promotion.pipe(Option.getOrThrow)).toMatchObject({ state: "promoted" });
  });

  it("drains a session again after a promoted turn start failed before dispatch", async () => {
    const harness = await createHarness();
    // The queued message carries a managed attachment whose file disappears
    // between queueing and promotion (a real scenario: attachment GC, or the
    // state dir being cleaned while a turn waits in the queue). The promoted
    // turn start then fails in `resolveProviderDispatchAttachments`, which sits
    // *before* `dispatchTurnForThread` — whose own `catchCause` is the only
    // place that releases the reservation on a failure. The generator is
    // abandoned while the session still holds its queued-dispatch reservation.
    // That reservation gates `drainQueuedTurnsForThread` and makes
    // `processQueueDrainEvent` absorb terminal events instead of draining, so
    // leaking it strands every later queued message on this provider session
    // for the rest of the process lifetime.
    const attachment = {
      type: "image",
      id: `att_v2_${"a1b2c3d4".repeat(4)}`,
      name: "vanishes.png",
      mimeType: "image/png",
      sizeBytes: 3,
    } as const;
    const attachmentPath = await harness.stageAttachment(attachment);
    const queuedSequence = await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-reservation"),
      messageId: asMessageId("msg-queue-reservation"),
      text: "this promotion never reaches the provider",
      attachments: [attachment],
    });
    fs.rmSync(attachmentPath, { force: true });

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-reservation"),
      eventId: "evt-turn-completed-reservation",
    });
    // The promotion is consumed and then fails; nothing reaches the provider.
    await waitFor(async () => {
      const promotion = await Effect.runPromise(
        harness.queuedTurnPromotionRepository.getBySequence(queuedSequence),
      );
      return Option.getOrUndefined(promotion)?.state === "promoted";
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();

    // Second call: a fresh queued message behind a fresh live turn must still
    // promote when that turn settles.
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-reservation-next"),
      messageId: asMessageId("msg-queue-reservation-next"),
      text: "promote me after the failed promotion",
    });
    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-reservation-next"),
      eventId: "evt-turn-completed-reservation-next",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "promote me after the failed promotion",
    });
  });

  it("does not promote another queued turn while the reactor is shutting down", async () => {
    const harness = await createHarness();
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-shutdown"),
      messageId: asMessageId("msg-queue-shutdown-1"),
      text: "first queued turn",
    });
    const secondQueuedSequence = await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-shutdown"),
      messageId: asMessageId("msg-queue-shutdown-2"),
      text: "stay queued for the next boot",
    });

    let promotionDispatches = 0;
    harness.interceptEngineDispatch((command) => {
      if (command.type === "thread.turn.dispatch-queued") {
        promotionDispatches += 1;
      }
      return undefined;
    });
    // Keep the first promotion in flight until closing the reactor scope
    // interrupts it. The second message must remain durable queued work.
    harness.sendTurn.mockImplementationOnce(() => Effect.never);

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-shutdown"),
      eventId: "evt-turn-completed-shutdown",
    });
    await waitFor(() => promotionDispatches === 1 && harness.sendTurn.mock.calls.length === 1);

    const activeScope = scope;
    expect(activeScope).not.toBeNull();
    await Effect.runPromise(Scope.close(activeScope!, Exit.void));
    scopes.delete(activeScope!);
    scope = null;

    expect(promotionDispatches).toBe(1);
    const secondPromotion = await Effect.runPromise(
      harness.queuedTurnPromotionRepository.getBySequence(secondQueuedSequence),
    );
    expect(secondPromotion.pipe(Option.getOrThrow)).toMatchObject({
      state: "queued",
      claimOwner: null,
    });
  });

  it("releases a timed-out promoted turn when its live provider turn settles", async () => {
    const harness = await createHarness({
      // Admission must finish before the deliberately non-returning provider call times out.
      commandEventTimeout: Duration.seconds(1),
    });
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-timeout"),
      messageId: asMessageId("msg-queue-timeout-1"),
      text: "first queued turn times out after provider acceptance",
    });
    await seedQueuedTurnBehindLiveTurn(harness, {
      liveTurnId: asTurnId("turn-running-timeout"),
      messageId: asMessageId("msg-queue-timeout-2"),
      text: "second queued turn must drain after settlement",
    });

    const timedOutTurnId = asTurnId("turn-provider-accepted-before-timeout");
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.sync(() =>
        harness.setRuntimeSessionTurnState({
          threadId: "thread-1",
          status: "running",
          activeTurnId: timedOutTurnId,
        }),
      ).pipe(Effect.andThen(Effect.never)),
    );

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-running-timeout"),
      eventId: "evt-turn-completed-timeout",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () =>
      Effect.runPromise(
        harness.deliveryRepository
          .firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId: "thread-1",
          })
          .pipe(Effect.map(Option.isSome)),
      ),
    );

    const blocker = (
      await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId: "thread-1",
        }),
      )
    ).pipe(Option.getOrThrow);
    await Effect.runPromise(
      harness.reactor.reconcileDelivery({
        eventSequence: blocker.eventSequence,
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedState: "uncertain",
        outcome: "abandon",
        reconciledBy: "test-operator",
        note: "The provider accepted the timed-out turn.",
      }),
    );

    await settleLiveTurn(harness, {
      turnId: timedOutTurnId,
      eventId: "evt-provider-turn-completed-after-timeout",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "second queued turn must drain after settlement",
    });
  });
});
