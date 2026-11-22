// FILE: ProviderCommandReactor.queueAndHandoff.test.ts
// Purpose: ProviderCommandReactor cases for queued turns, Stop authority, Debug mode, group tools, and same-thread provider handoff.
// Layer: Orchestration integration tests
// Depends on: providerCommandReactorHarness (ProviderCommandReactorLive with in-memory provider
//             and persistence services).
// Note: one contiguous slice of the former single ProviderCommandReactor.test.ts, in its
//       original order, so CI can run the slices on separate workers.

import { planRestartTurnReconciliation } from "../startupTurnReconciliation.ts";
import type { ModelSelection, ProviderRuntimeEvent, ProviderSession } from "@synara/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { Duration, Deferred, Effect, Exit, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeAgentGatewaySessionRegistry } from "../../agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { type ProviderRuntimeSessionStopTarget } from "../../provider/Services/ProviderService.ts";
import * as groupsBetaGate from "../../projectAgent/groupsBetaGate.ts";
import { OrchestrationCommandInvariantError, ProviderDeliveryRecoveryError } from "../Errors.ts";
import { PROVIDER_DEBUG_MODE_PROMPT_PREFIX } from "../../provider/debugMode.ts";
import {
  asProjectId,
  asEventId,
  asMessageId,
  asTurnId,
  waitFor,
  createRetainingRestartProviderServiceLayer,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("ProviderCommandReactor", () => {
  const {
    createHarness,
    seedRollbackTarget,
    readHarnessThread,
    startNativeChildTurn,
    dispatchHarnessUserTurn,
    setHarnessSession,
    emitHarnessTurnTerminal,
    seedQueuedTurnBehindLiveTurn,
    settleLiveTurn,
  } = useProviderCommandReactorHarness();

  it("keeps the next queued turn blocked until the promoted turn settles", async () => {
    const harness = await createHarness();
    const firstSendGate: {
      release: ((value: { readonly threadId: ThreadId; readonly turnId: TurnId }) => void) | null;
    } = { release: null };
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.tryPromise(
        () =>
          new Promise<{ readonly threadId: ThreadId; readonly turnId: TurnId }>((resolve) => {
            firstSendGate.release = resolve;
          }),
      ),
    );
    const liveTurnId = asTurnId("turn-running-before-promotion");
    for (const [messageId, text] of [
      ["msg-queue-promoted-1", "first queued turn"],
      ["msg-queue-promoted-2", "second queued turn"],
    ] as const) {
      await seedQueuedTurnBehindLiveTurn(harness, {
        liveTurnId,
        messageId: asMessageId(messageId),
        text,
      });
    }

    await settleLiveTurn(harness, {
      turnId: liveTurnId,
      eventId: "evt-turn-completed-promote-first",
    });

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
      turnId: liveTurnId,
      payload: {
        reason: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);

    await settleLiveTurn(harness, {
      turnId: asTurnId("turn-promoted-1"),
      eventId: "evt-turn-completed-promoted-first",
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "second queued turn",
    });
  });

  it("releases a promoted-turn reservation on an id-less terminal event once the session is idle", async () => {
    const harness = await createHarness();
    const liveTurnId = asTurnId("turn-running-before-idless-abort");
    for (const [messageId, text] of [
      ["msg-before-idless-abort", "promote before id-less abort"],
      ["msg-after-idless-abort", "release after id-less abort"],
    ] as const) {
      await seedQueuedTurnBehindLiveTurn(harness, {
        liveTurnId,
        messageId: asMessageId(messageId),
        text,
      });
    }
    await settleLiveTurn(harness, {
      turnId: liveTurnId,
      eventId: "evt-complete-before-idless-abort",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.aborted",
      eventId: asEventId("evt-idless-abort-promoted-turn"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      payload: { reason: "interrupted" },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "release after id-less abort",
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

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-child-turn-start",
      threadId: ThreadId.makeUnsafe("thread-child"),
      messageId: "msg-child-queued",
      text: "child follow-up",
      createdAt: now,
    });

    await harness.drain();
    // A raw child-id session lookup would miss the parent's live turn and
    // dispatch immediately, overlapping the shared provider session.
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await settleLiveTurn(harness, {
      eventId: "evt-parent-turn-completed",
      turnId: asTurnId("turn-parent-running"),
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child"),
      input: "child follow-up",
    });
  });

  it("discards queued child turns when the shared parent session stops", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-thread-create-before-parent-stop"),
        threadId: ThreadId.makeUnsafe("thread-child-before-parent-stop"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Queued child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-parent-before-stop"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-parent-session-running-before-stop",
      status: "running",
      providerName: "codex",
      activeTurnId: asTurnId("turn-parent-before-stop"),
      at: now,
    });
    harness.sendTurn.mockClear();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-child-turn-queued-before-parent-stop",
      threadId: ThreadId.makeUnsafe("thread-child-before-parent-stop"),
      messageId: "msg-child-queued-before-parent-stop",
      text: "must be discarded with the stopped session",
      createdAt: now,
    });
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-parent-session-stop-with-child-queued"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );
    await waitFor(() => harness.stopRuntimeSession.mock.calls.length === 1);

    await settleLiveTurn(harness, {
      eventId: "evt-parent-terminal-after-explicit-stop",
      turnId: asTurnId("turn-parent-before-stop"),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(harness.sendTurn).not.toHaveBeenCalled();
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

    await settleLiveTurn(harness, {
      eventId: "evt-parent-turn-completed-sibling-drain",
      turnId: asTurnId("turn-parent-running-siblings"),
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-child-b"),
      input: "second child follow-up",
    });
  });

  it("drains a shared child queue after a direct parent turn fails to start", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-direct-failure-child-create"),
        threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
        projectId: asProjectId("project-1"),
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        title: "Queued child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-before-direct-failure"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-direct-failure-session-running",
      status: "running",
      providerName: "codex",
      activeTurnId: asTurnId("turn-before-direct-failure"),
      at: now,
    });

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-queue-child-before-direct-failure",
      threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
      messageId: "msg-child-before-direct-failure",
      text: "recover this queued child",
      createdAt: now,
    });
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    // Make the provider idle without a terminal event. The child follow-up is
    // still queued when the next parent start takes the direct path.
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await setHarnessSession(harness, {
      commandId: "cmd-direct-failure-session-ready",
      status: "ready",
      providerName: "codex",
      at: now,
    });
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "direct parent start failed",
        }),
      ),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-direct-parent-start-fails-with-child-queued",
      messageId: "msg-direct-parent-start-fails",
      text: "this direct parent turn fails",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "this direct parent turn fails",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-direct-failure-child"),
      input: "recover this queued child",
    });
  });

  it("promotes a queued turn immediately when the provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection still says the thread is running (stale), but the provider
    // turn has already settled: its terminal event was consumed before this
    // message was queued, so no future drain trigger will ever arrive.
    await setHarnessSession(harness, {
      commandId: "cmd-session-stale-running",
      status: "running",
      providerName: "codex",
      activeTurnId: asTurnId("turn-already-settled"),
      at: now,
    });

    harness.sendTurn.mockClear();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-queue-stale",
      messageId: "msg-queue-stale",
      text: "recover me",
      createdAt: now,
    });

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

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-race",
      messageId: "msg-turn-race",
      text: "wait your turn",
      createdAt: now,
    });

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await settleLiveTurn(harness, {
      eventId: "evt-turn-completed-race",
      turnId: asTurnId("turn-live-race"),
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "wait your turn",
    });
  });

  it("steers Debug turns immediately with one prompt prefix", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-running-steer-codex",
      status: "running",
      providerName: "codex",
      activeTurnId: asTurnId("turn-running"),
      at: now,
    });

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
        interactionMode: "debug",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "debug",
    });
    const steerInput = harness.steerTurn.mock.calls[0]?.[0] as { readonly input?: string };
    expect(steerInput.input).toContain("pivot now");
    expect(steerInput.input?.split(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)).toHaveLength(2);
    const message = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads[0]?.messages.find((entry) => entry.id === "msg-steer-codex");
    expect(message?.turnId).toBeNull();
    expect(message?.startsNewTurn).toBe(false);
  });

  it("dispatches a codex steer as a queued turn when the live provider turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Projection lags: it still says running, but the provider runtime has no
    // live turn. The steer must not ride the native codex steer path (which
    // would skip the turn-start checkpoint) — it dispatches as a normal turn.
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await setHarnessSession(harness, {
      commandId: "cmd-session-stale-steer-codex",
      status: "running",
      providerName: "codex",
      activeTurnId: asTurnId("turn-settled"),
      at: now,
    });

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
    await harness.drain();
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "steer but nothing is running",
    });
    const message = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads[0]?.messages.find((entry) => entry.id === "msg-steer-codex-stale");
    expect(message?.turnId).toBe("turn-1");
    expect(message?.startsNewTurn).toBe(true);
  });

  it("never interrupts the live turn for an ordinary queue follow-up", async () => {
    // Declared policy (agentGateway/followUpDispatchPolicy.ts): queue runs
    // after the live turn; only steer may interrupt. A steer on the same
    // provider — the fallback path asserted below — does interrupt.
    const harness = await createHarness({
      threadModelSelection: {
        provider: "cursor",
        model: "composer-1",
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-running-queue-cursor",
      status: "running",
      providerName: "cursor",
      activeTurnId: asTurnId("turn-running"),
      at: now,
    });

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-queue-cursor"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-queue-cursor"),
          role: "user",
          text: "one more thing",
          attachments: [],
        },
        dispatchMode: "queue",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    const queuedMessage = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads[0]?.messages.find((entry) => entry.id === "msg-queue-cursor");
    expect(queuedMessage).toMatchObject({
      dispatchMode: "queue",
      startsNewTurn: true,
      turnId: null,
    });

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await emitHarnessTurnTerminal(harness, {
      eventId: "evt-turn-completed-queue-cursor",
      provider: "cursor",
      type: "completed",
      turnId: asTurnId("turn-running"),
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "one more thing",
    });
  });

  it("falls back to interrupt plus priority queue for steering without native support", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "cursor",
        model: "composer-1",
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-running"),
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-running-steer-cursor",
      status: "running",
      providerName: "cursor",
      activeTurnId: asTurnId("turn-running"),
      at: now,
    });

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    harness.interruptTurn.mockClear();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-steer-cursor"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("msg-steer-cursor"),
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
    const queuedMessage = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads[0]?.messages.find((entry) => entry.id === "msg-steer-cursor");
    expect(queuedMessage).toMatchObject({
      dispatchMode: "steer",
      startsNewTurn: true,
      turnId: null,
    });
    const queuedProjectedMessages = await Effect.runPromise(
      harness.sql<{
        readonly turnId: string | null;
        readonly dispatchMode: string | null;
        readonly startsNewTurn: number | null;
      }>`
        SELECT turn_id AS "turnId", dispatch_mode AS "dispatchMode",
          starts_new_turn AS "startsNewTurn"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1' AND message_id = 'msg-steer-cursor'
      `,
    );
    expect(queuedProjectedMessages).toEqual([
      { turnId: null, dispatchMode: "steer", startsNewTurn: 1 },
    ]);

    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-steer-cursor"),
      provider: "cursor",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-running"),
      payload: {
        state: "interrupted",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "switch directions",
    });
    const message = (
      await Effect.runPromise(harness.engine.getReadModel())
    ).threads[0]?.messages.find((entry) => entry.id === "msg-steer-cursor");
    expect(message).toMatchObject({ turnId: "turn-1", startsNewTurn: true });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.user.bind-turn",
        commandId: CommandId.makeUnsafe("cmd-bind-steer-cursor-same-turn-again"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("msg-steer-cursor"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );
    await harness.drain();
    const projectedMessages = await Effect.runPromise(
      harness.sql<{
        readonly turnId: string | null;
        readonly dispatchMode: string | null;
        readonly startsNewTurn: number | null;
      }>`
        SELECT turn_id AS "turnId", dispatch_mode AS "dispatchMode",
          starts_new_turn AS "startsNewTurn"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1' AND message_id = 'msg-steer-cursor'
      `,
    );
    expect(projectedMessages).toEqual([
      { turnId: "turn-1", dispatchMode: "steer", startsNewTurn: 1 },
    ]);
  });

  it.each([false, true])(
    "preserves the native cursor when relocating a project (background tasks: %s)",
    async (backgroundTasks) => {
      const modelSelection: ModelSelection = {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
      };
      const harness = await createHarness({ threadModelSelection: modelSelection });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const original = await Effect.runPromise(
        harness.startSession(threadId, {
          threadId,
          provider: "claudeAgent",
          modelSelection,
          runtimeMode: "approval-required",
          cwd: "/tmp/provider-project",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("seed-relocation-session"),
          threadId,
          createdAt: now,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("relocate-project"),
          projectId: ProjectId.makeUnsafe("project-1"),
          workspaceRoot: "/tmp/restored-provider-project",
        }),
      );
      harness.hasLiveRuntimeTasks.mockImplementation(() => Effect.succeed(backgroundTasks));
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("resume-relocated-thread"),
          threadId,
          message: {
            messageId: asMessageId("message-relocated"),
            role: "user",
            text: "Continue our existing work",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      if (backgroundTasks) {
        await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
        expect((await readHarnessThread(harness))?.session?.lastError).toContain(
          "background tasks",
        );
        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      } else {
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.startSession).toHaveBeenCalledTimes(2);
        expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
          threadId,
          cwd: "/tmp/restored-provider-project",
          resumeCursor: original.resumeCursor,
        });
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ threadId });
        expect((await readHarnessThread(harness))?.id).toBe(threadId);
      }
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    },
  );

  it("applies spawn-fixed Claude selection changes when the next turn starts", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const startTurn = (id: string, extra: { modelSelection?: ModelSelection } = {}) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-${id}`),
            role: "user",
            text: id,
            attachments: [],
          },
          ...extra,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    await startTurn("claude-bootstrap");
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-7" },
    });
    harness.startSession.mockClear();

    // A stored pick never restarts the idle session on its own.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-1m"),
        threadId,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-7",
          options: { contextWindow: "1m" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    // The next turn applies it: a context override is spawn-fixed and resumes
    // the same conversation.
    await startTurn("claude-1m");
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { contextWindow: "1m" },
      },
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    harness.startSession.mockClear();

    // Effort is fixed at subprocess spawn, so an effort change restarts at the next turn.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-meta-update-claude-effort"),
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
    await startTurn("claude-max");
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { effort: "max" },
      },
    });
  });

  it("applies a stored pick to a turn that names no selection on a restart-only provider", async () => {
    const harness = await createHarness({ sessionModelSwitch: "restart-session" });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const startTurn = (id: string, extra: { modelSelection?: ModelSelection } = {}) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-${id}`),
            role: "user",
            text: id,
            attachments: [],
          },
          ...extra,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    await startTurn("restart-only-bootstrap");
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-meta-restart-only-pick"),
        threadId,
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      }),
    );
    await harness.drain();
    // No idle restart: the session would publish `starting` without a turn.
    expect(harness.startSession.mock.calls.length).toBe(1);

    // A goal continuation or an older client sends no selection; the stored pick
    // still decides the model the session restarts on.
    await startTurn("restart-only-follow-up");
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      modelSelection: { provider: "codex", model: "gpt-5.5" },
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { provider: "codex", model: "gpt-5.5" },
    });
  });

  it("keeps a model change for the next turn while the runtime still runs one", async () => {
    const harness = await createHarness({ sessionModelSwitch: "restart-session" });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-live-model-change"),
        threadId,
        message: {
          messageId: asMessageId("user-message-live-model-change"),
          role: "user",
          text: "start a long turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // The runtime has started the turn; the projection has not caught up yet.
    const sessions = await Effect.runPromise(harness.listSessions());
    harness.listSessions.mockReturnValue(
      Effect.succeed(
        sessions.map((session) => ({
          ...session,
          status: "running" as const,
          activeTurnId: asTurnId("turn-live-model-change"),
        })),
      ),
    );
    expect((await readHarnessThread(harness))?.session?.activeTurnId).toBeNull();

    const change = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-meta-live-model-change"),
        threadId,
        modelSelection: { provider: "codex", model: "gpt-5.5" },
      }),
    );
    await waitFor(async () => {
      const state = await Effect.runPromise(
        harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
      );
      return state.pipe(Option.getOrThrow).lastAckedSequence >= change.sequence;
    });

    // The live turn keeps running; the change waits on the thread for the next turn.
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    const thread = await readHarnessThread(harness);
    expect(thread?.modelSelection.model).toBe("gpt-5.5");
    expect(thread?.session?.lastError ?? null).toBeNull();
  });

  it("restarts a directly started Claude session at the next turn when spawn-fixed options change", async () => {
    const initialSelection: ModelSelection = {
      provider: "claudeAgent",
      model: "claude-opus-4-7",
    };
    const harness = await createHarness({ threadModelSelection: initialSelection });
    const threadId = ThreadId.makeUnsafe("thread-1");

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

    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    // The next turn compares the stored pick with the spawn profile learned from
    // thread.created, even though the reactor did not start this session.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-direct-claude-turn"),
        threadId,
        message: {
          messageId: asMessageId("user-message-direct-claude"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: importedSession.updatedAt,
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
          options: { autoCompactWindow: "200k" },
        },
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    harness.sendTurn.mockClear();
    harness.steerTurn.mockClear();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-reject-context-steer"),
        threadId,
        dispatchMode: "steer",
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        message: {
          messageId: asMessageId("reject-context-steer"),
          role: "user",
          text: "steer",
          attachments: [],
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();

    expect(
      (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.session,
    ).toMatchObject({
      status: "running",
      activeTurnId: turnId,
    });

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

    // No explicit selection: the persisted desired override must still apply.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-idle-context-send"),
        threadId,
        runtimeMode: "approval-required",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        message: {
          messageId: asMessageId("idle-context-send"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        options: { autoCompactWindow: "200k" },
      },
    });
  });

  it.each([
    "retained cleanup",
    "new epoch",
    "same-runtime T2",
    "no receipt",
    "inherited idle",
    "non-user idle",
  ] as const)(
    "explicit idle Retry Stop handles %s without adopting another target",
    async (scenario) => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const firstTurnId = asTurnId("retry-stop-original");
      const now = new Date().toISOString();
      await seedRollbackTarget(harness, {
        messageId: asMessageId("retry-stop-source"),
        turnId: firstTurnId,
        createdAt: now,
      });
      const session = {
        threadId,
        providerName: "claudeAgent" as const,
        runtimeMode: "approval-required" as const,
        status: "interrupted" as const,
        activeTurnId: null,
        lastError: formatProviderDeliveryBlockDetail("Synthetic uncertain send"),
        updatedAt: now,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("retry-stop-idle-session"),
          threadId,
          session,
          createdAt: now,
        }),
      );
      await harness.drain();
      const receipt = {
        controlRequestId: "command:original-explicit-stop",
        observedLifecycleGeneration: "original-runtime",
        turnId: firstTurnId,
      };
      let target: ProviderRuntimeSessionStopTarget = {
        lifecycleGeneration: scenario === "new epoch" ? "replacement-runtime" : "original-runtime",
        session:
          scenario === "same-runtime T2"
            ? {
                threadId,
                provider: "claudeAgent",
                runtimeMode: "approval-required",
                status: "running",
                activeTurnId: asTurnId("retry-stop-T2"),
                createdAt: now,
                updatedAt: now,
              }
            : null,
        ...(scenario !== "no receipt" ? { stopControlReceipt: receipt } : {}),
        ...(scenario === "inherited idle"
          ? { inheritedLifecycleGeneration: "original-runtime" }
          : {}),
      };
      harness.getRuntimeSessionStopTarget.mockImplementation(() => Effect.succeed(target));
      let cleanupCompleted = false;
      harness.stopRuntimeSession.mockImplementation((request) =>
        Effect.sync(() => {
          expect(request).toMatchObject({
            threadId,
            controlRequestId: receipt.controlRequestId,
            expectedLifecycleGeneration: receipt.observedLifecycleGeneration,
          });
          cleanupCompleted = true;
          target = {
            session: null,
            lifecycleGeneration: "retired-runtime",
            stopControlReceipt: { ...receipt, retiredLifecycleGeneration: "retired-runtime" },
          };
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("new-explicit-retry-stop"),
          threadId,
          turnId: firstTurnId,
          requestedBy: scenario === "non-user idle" ? "agent" : "user",
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      expect(cleanupCompleted).toBe(scenario === "retained cleanup");
      expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(
        scenario === "retained cleanup" ? 1 : 0,
      );
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.session).toMatchObject(
        scenario === "retained cleanup"
          ? { status: "stopped", activeTurnId: null, lastError: session.lastError }
          : session,
      );
    },
  );

  it.each([
    "failed start",
    "interrupted projection",
    "replacement epoch",
    "no blocker",
    "agent Stop",
    "ready runtime",
    "ready T2",
    "ready replacement epoch",
    "ready retry",
    "ready retry T2",
    "ready retry replacement epoch",
    "ready no blocker",
    "ready agent Stop",
  ] as const)("explicit recovery Stop uses real lifecycle authority with %s", async (scenario) => {
    let failStart = false;
    const readyRuntime = scenario.startsWith("ready");
    const retryStop = scenario.startsWith("ready retry");
    const retryT2 = scenario === "ready retry T2";
    const retryEpoch = scenario === "ready retry replacement epoch";
    const hasBlocker = !scenario.endsWith("no blocker");
    const userStop = !scenario.endsWith("agent Stop");
    const replacementEpoch = scenario.includes("replacement epoch") && !retryStop;
    const replacementTurn = scenario === "ready T2";
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      providerServiceLayer: createRetainingRestartProviderServiceLayer({
        failFirstTeardown: retryStop,
        keepLiveOnFailedTeardown: retryT2,
        liveTurns: true,
        failStart: () => failStart,
      }),
      startReactor: false,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    const provider = harness.realProviderService;
    const readTarget = provider.getRuntimeSessionStopTarget!;
    await Effect.runPromise(
      provider.startSession(threadId, {
        threadId,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      }),
    );
    if (!readyRuntime) {
      await Effect.runPromise(provider.stopRuntimeSession!({ threadId }));
      const beforeFailure = await Effect.runPromise(readTarget({ threadId }));
      failStart = true;
      const failed = await Effect.runPromise(
        provider
          .startSession(threadId, {
            threadId,
            provider: "claudeAgent",
            runtimeMode: "approval-required",
          })
          .pipe(Effect.exit),
      );
      failStart = false;
      expect(Exit.isFailure(failed)).toBe(true);
      expect((await Effect.runPromise(readTarget({ threadId }))).lifecycleGeneration).toBe(
        beforeFailure.lifecycleGeneration,
      );
    }
    const rewound = await Effect.runPromise(readTarget({ threadId }));
    if (readyRuntime) expect(rewound.session).toMatchObject({ status: "ready" });
    else expect(rewound.session).toBeNull();
    expect(rewound.inheritedLifecycleGeneration).toBeUndefined();
    expect(rewound.stopControlReceipt).toBeUndefined();
    const source = await dispatchHarnessUserTurn(harness, {
      messageId: "rewound-uncertain-send",
      text: "Ambiguous synthetic send",
      createdAt: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("rewound-idle-session"),
        threadId,
        session: {
          threadId,
          providerName: "claudeAgent",
          status: scenario === "interrupted projection" ? "interrupted" : "stopped",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    if (hasBlocker) {
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          threadId,
          claimOwner: "previous-owner",
          claimedAt: now,
          claimExpiresAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.markTerminalFailure({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          expectedClaimOwner: "previous-owner",
          state: "uncertain",
          error: "Synthetic ambiguity",
          updatedAt: now,
        }),
      );
    }
    for (const event of Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    )) {
      await Effect.runPromise(
        harness.deliveryRepository.advanceCursor({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: event.sequence,
          updatedAt: now,
        }),
      );
    }
    await harness.startReactor();
    const recover = () =>
      Effect.runPromise(
        harness.reactor.reconcileDelivery({
          threadId,
          eventSequence: source.sequence,
          expectedState: "uncertain",
          outcome: "abandon",
          reconciledBy: "test-rewound-explicit-stop",
        }),
      );
    if (hasBlocker) {
      expect(await recover().catch((error: unknown) => error)).toMatchObject({
        reason: readyRuntime ? "stop-required" : "stop-unconfirmed",
      });
    }
    const sends = vi.spyOn(provider, "sendTurn");
    const interrupts = vi.spyOn(provider, "interruptTurn");
    const stops = vi.spyOn(provider, "stopRuntimeSession");
    if (replacementEpoch || replacementTurn) {
      vi.spyOn(provider, "getRuntimeSessionStopTarget").mockImplementationOnce((input) =>
        readTarget(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (replacementEpoch)
                yield* provider.startSession(threadId, {
                  threadId,
                  provider: "claudeAgent",
                  runtimeMode: "approval-required",
                });
              yield* provider.sendTurn({ threadId, input: "Replacement" });
            }),
          ),
        ),
      );
    }
    const commandId = CommandId.makeUnsafe("rewound-new-explicit-stop");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId,
        threadId,
        ...(scenario === "interrupted projection" || retryStop
          ? { turnId: asTurnId("old-turn-never-projected") }
          : {}),
        requestedBy: userStop ? "user" : "agent",
        createdAt: now,
      }),
    );
    await harness.drain();
    if (retryStop) {
      const incomplete = await Effect.runPromise(readTarget({ threadId }));
      expect(incomplete.stopControlReceipt).toMatchObject({
        controlRequestId: `command:${commandId}`,
        observedLifecycleGeneration: rewound.lifecycleGeneration,
        turnId: null,
      });
      expect(incomplete.stopControlReceipt?.retiredLifecycleGeneration).toBeUndefined();
      expect(await recover().catch((error: unknown) => error)).toMatchObject({
        reason: incomplete.session === null ? "stop-unconfirmed" : "stop-required",
      });
      if (retryEpoch)
        await Effect.runPromise(
          provider.startSession(threadId, {
            threadId,
            provider: "claudeAgent",
            runtimeMode: "approval-required",
          }),
        );
      if (retryT2 || retryEpoch)
        await Effect.runPromise(provider.sendTurn({ threadId, input: "Replacement after Stop" }));
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("rewound-explicit-retry"),
          threadId,
          turnId: asTurnId("old-turn-never-projected"),
          requestedBy: "user",
          createdAt: now,
        }),
      );
      await harness.drain();
      expect(
        stops.mock.calls.map(([input]) => [input?.controlRequestId, input?.onlyIfNoActiveTurn]),
      ).toEqual(
        retryT2 || retryEpoch
          ? [[`command:${commandId}`, true]]
          : [
              [`command:${commandId}`, true],
              [`command:${commandId}`, true],
            ],
      );
    }
    const after = await Effect.runPromise(readTarget({ threadId }));
    if (
      scenario === "failed start" ||
      scenario === "interrupted projection" ||
      scenario === "ready runtime" ||
      scenario === "ready retry"
    ) {
      expect(after.stopControlReceipt).toMatchObject({
        controlRequestId: `command:${commandId}`,
        observedLifecycleGeneration: rewound.lifecycleGeneration,
        retiredLifecycleGeneration: after.lifecycleGeneration,
      });
      expect(after.lifecycleGeneration).not.toBe(rewound.lifecycleGeneration);
      expect(await recover()).toMatchObject({ state: "succeeded", outcome: "abandon" });
    } else {
      if (retryT2 || retryEpoch) {
        expect(after.stopControlReceipt).toMatchObject({
          controlRequestId: `command:${commandId}`,
          observedLifecycleGeneration: rewound.lifecycleGeneration,
          turnId: null,
        });
        expect(after.stopControlReceipt?.retiredLifecycleGeneration).toBeUndefined();
      } else expect(after.stopControlReceipt).toBeUndefined();
      if (replacementEpoch || replacementTurn || retryT2 || retryEpoch) {
        if (replacementEpoch || retryEpoch)
          expect(after.lifecycleGeneration).not.toBe(rewound.lifecycleGeneration);
        else expect(after.lifecycleGeneration).toBe(rewound.lifecycleGeneration);
        expect(after.session).toMatchObject({
          status: "running",
          activeTurnId: "claudeAgent-turn",
        });
      } else {
        expect(after.lifecycleGeneration).toBe(rewound.lifecycleGeneration);
        expect(stops).not.toHaveBeenCalled();
      }
    }
    expect(interrupts).not.toHaveBeenCalled();
    expect(sends).toHaveBeenCalledTimes(
      replacementEpoch || replacementTurn || retryT2 || retryEpoch ? 1 : 0,
    );
  });

  it.each([
    "session stop",
    "turn interrupt",
    "turn interrupt no ACK",
    "turn interrupt no ACK cleanup failed",
    "turn interrupt no ACK missing receipt",
    "turn interrupt no ACK T2",
  ] as const)(
    "keeps public %s recovery consistent with its real retirement receipt",
    async (stopKind) => {
      const noAck = stopKind.includes("no ACK");
      const cleanupFailed = stopKind.endsWith("cleanup failed");
      const missingReceipt = stopKind.endsWith("missing receipt");
      const replacement = stopKind.endsWith("T2");
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
        providerServiceLayer: createRetainingRestartProviderServiceLayer({
          failFirstTeardown: cleanupFailed,
          liveTurns: true,
          interruptFailure: noAck,
        }),
        startReactor: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const provider = harness.realProviderService;
      if (!provider.getRuntimeSessionStopTarget)
        throw new Error("Expected real Stop receipt support");
      await Effect.runPromise(
        provider.startSession(threadId, {
          threadId,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        }),
      );
      const turn = await Effect.runPromise(
        provider.sendTurn({ threadId, input: "Owned synthetic work" }),
      );
      const original = await Effect.runPromise(provider.getRuntimeSessionStopTarget({ threadId }));
      const source = await dispatchHarnessUserTurn(harness, {
        messageId: "real-public-stop-uncertain",
        text: "Ambiguous synthetic send",
        createdAt: now,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("real-public-stop-running"),
          threadId,
          session: {
            threadId,
            providerName: "claudeAgent",
            status: "running",
            runtimeMode: "approval-required",
            activeTurnId: turn.turnId,
            lastError: formatProviderDeliveryBlockDetail("Synthetic ambiguity"),
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      // Keep the original send uncertain without executing or replaying it.
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          threadId,
          claimOwner: "previous-owner",
          claimedAt: now,
          claimExpiresAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.markTerminalFailure({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          expectedClaimOwner: "previous-owner",
          state: "uncertain",
          error: "Synthetic ambiguity",
          updatedAt: now,
        }),
      );
      for (const event of Array.from(
        await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
      )) {
        await Effect.runPromise(
          harness.deliveryRepository.advanceCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            updatedAt: now,
          }),
        );
      }
      const readStopTarget = provider.getRuntimeSessionStopTarget;
      const stopRuntime = provider.stopRuntimeSession!;
      const sends = vi.spyOn(provider, "sendTurn");
      const interrupts = vi.spyOn(provider, "interruptTurn");
      const stops = vi.spyOn(provider, "stopRuntimeSession");
      if (replacement || missingReceipt)
        stops.mockImplementationOnce((input) =>
          stopRuntime(input).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (replacement) {
                  yield* provider.startSession(threadId, {
                    threadId,
                    provider: "claudeAgent",
                    runtimeMode: "approval-required",
                  });
                  yield* provider.sendTurn({ threadId, input: "Explicit replacement" });
                } else {
                  vi.spyOn(provider, "getRuntimeSessionStopTarget").mockImplementation((request) =>
                    readStopTarget(request).pipe(
                      Effect.map((target) => {
                        const { stopControlReceipt: _receipt, ...unverified } = target;
                        return unverified;
                      }),
                    ),
                  );
                }
              }),
            ),
          ),
        );
      await harness.startReactor();
      const commandId = CommandId.makeUnsafe("real-public-explicit-stop");
      await Effect.runPromise(
        harness.engine.dispatch(
          stopKind === "session stop"
            ? {
                type: "thread.session.stop",
                commandId,
                threadId,
                createdAt: now,
              }
            : {
                type: "thread.turn.interrupt",
                commandId,
                threadId,
                turnId: turn.turnId,
                requestedBy: "user",
                createdAt: now,
              },
        ),
      );
      await harness.drain();
      const retired = await Effect.runPromise(readStopTarget({ threadId }));
      const failure = (await readHarnessThread(harness))?.activities.find(
        (activity) => activity.kind === "provider.turn.interrupt.failed",
      );
      if (replacement) {
        expect(retired.session).toMatchObject({
          status: "running",
          activeTurnId: "claudeAgent-turn",
        });
        expect(retired.lifecycleGeneration).not.toBe(original.lifecycleGeneration);
        expect(retired.stopControlReceipt?.retiredLifecycleGeneration).not.toBe(
          retired.lifecycleGeneration,
        );
        expect(failure).toBeDefined();
        expect(stops).toHaveBeenCalledTimes(1);
        expect(sends).toHaveBeenCalledTimes(1);
        return;
      }
      if (cleanupFailed) {
        expect(retired.stopControlReceipt).toMatchObject({
          controlRequestId: `command:${commandId}`,
          observedLifecycleGeneration: original.lifecycleGeneration,
        });
        expect(retired.stopControlReceipt?.retiredLifecycleGeneration).toBeUndefined();
        expect(retired.lifecycleGeneration).toBe(original.lifecycleGeneration);
        expect(failure).toBeDefined();
        expect((failure?.payload as { detail?: string })?.detail).toContain("10000ms");
        expect(
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.session.stop.failed",
          ),
        ).toBe(true);
        return;
      }
      expect(retired.session).toBeNull();
      expect(retired.stopControlReceipt).toMatchObject({
        controlRequestId: `command:${commandId}`,
        observedLifecycleGeneration: original.lifecycleGeneration,
        retiredLifecycleGeneration: retired.lifecycleGeneration,
        turnId: turn.turnId,
      });
      expect(retired.lifecycleGeneration).not.toBe(original.lifecycleGeneration);
      expect(
        await Effect.runPromise(
          harness.reactor.reconcileDelivery({
            threadId,
            eventSequence: source.sequence,
            expectedState: "uncertain",
            outcome: "abandon",
            reconciledBy: "test-public-stop-recovery",
          }),
        ).catch((error: unknown) => error),
      ).toMatchObject(
        missingReceipt
          ? { reason: "stop-unconfirmed" }
          : { state: "succeeded", outcome: "abandon" },
      );
      if (missingReceipt) expect(failure).toBeDefined();
      else expect(failure).toBeUndefined();
      expect(sends).not.toHaveBeenCalled();
      expect(interrupts).toHaveBeenCalledTimes(stopKind === "session stop" ? 0 : 1);
      expect(stops).toHaveBeenCalledTimes(stopKind === "session stop" || noAck ? 1 : 0);
    },
  );

  it.each([
    ["live T1", "stop-required"],
    ["retained cleanup", "stop-unconfirmed"],
    ["unproven absence", "stop-unconfirmed"],
    ["unfinished Stop", "stop-unconfirmed"],
    ["replacement generation", "stop-unconfirmed"],
    ["live same-runtime T2", "stop-required"],
    ["old Stop receipt", "stop-unconfirmed"],
    ["remaining work", "stop-unconfirmed"],
    ["failed observation", "stop-unconfirmed"],
    ["changed after observation", "stop-unconfirmed"],
    ["verified retirement", null],
    ["inherited restart", null],
    ["inherited idle Stop", null],
    ["inherited retained cleanup", "stop-unconfirmed"],
    ["inherited new epoch", "stop-unconfirmed"],
    ["inherited acquired during observation", "stop-unconfirmed"],
    ["live edit resend", "stop-required"],
    ["live cache Continue", "stop-required"],
    ["known child owner", null],
  ] as const)("guards ambiguous Claude abandon with %s", async (scenario, reason) => {
    let retained: ProviderSession[] = [];
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      startReactor: false,
      ingestRuntimeEvents: scenario === "known child owner",
      listRetainedSessions: () => Effect.succeed(retained),
    });
    const threadId = ThreadId.makeUnsafe(
      scenario === "known child owner" ? "subagent:thread-1:recovery-child" : "thread-1",
    );
    const now = new Date().toISOString();
    if (scenario === "known child owner") {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("recovery-proof-child-create"),
          threadId,
          projectId: asProjectId("project-1"),
          title: "Recovery child",
          modelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          parentThreadId: ThreadId.makeUnsafe("thread-1"),
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      await startNativeChildTurn(harness, "recovery-child", "claudeAgent");
    }
    const stopCommandId = CommandId.makeUnsafe("recovery-proof-stop");
    const recordStop = () =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: stopCommandId,
          threadId,
          createdAt: now,
        }),
      );
    if (scenario === "old Stop receipt") await recordStop();
    let source = await dispatchHarnessUserTurn(harness, {
      messageId: "recovery-proof-message",
      text: "Ambiguous synthetic send",
      createdAt: now,
      threadId,
    });
    if (scenario === "live edit resend") {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("recovery-proof-edit-running"),
          threadId,
          session: {
            threadId,
            providerName: "claudeAgent",
            status: "running",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("recovery-original"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      source = await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.edit-and-resend",
          commandId: CommandId.makeUnsafe("recovery-proof-edit"),
          threadId,
          messageId: asMessageId("recovery-proof-message"),
          text: "Edited synthetic send",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: now,
        }),
      );
    } else if (scenario === "live cache Continue") {
      const review = {
        reviewId: "recovery-proof-review",
        messageId: asMessageId("recovery-proof-message"),
        sourceEventSequence: source.sequence,
        status: "pending" as const,
        createdAt: now,
        assessment: {
          observedAt: now,
          state: "likely-expired" as const,
          source: "request-usage" as const,
        },
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe("recovery-proof-review-set"),
          threadId,
          review,
          expectedReviewId: null,
          createdAt: now,
        }),
      );
      source = await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.respond",
          commandId: CommandId.makeUnsafe("recovery-proof-continue"),
          threadId,
          reviewId: review.reviewId,
          messageId: review.messageId,
          decision: "continue",
          createdAt: now,
        }),
      );
    }
    if (
      scenario !== "old Stop receipt" &&
      scenario !== "inherited restart" &&
      scenario !== "known child owner"
    )
      await recordStop();
    // Model a previous process's durable deliveries without replaying any sends.
    for (const event of Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    )) {
      if (
        [
          "thread.turn-start-requested",
          "thread.message-edit-resend-requested",
          "thread.claude-cache-response-requested",
          "thread.session-stop-requested",
        ].includes(event.type)
      ) {
        await Effect.runPromise(
          harness.deliveryRepository.claim({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            threadId,
            claimOwner: "recovery-proof-owner",
            claimedAt: now,
            claimExpiresAt: now,
          }),
        );
        await Effect.runPromise(
          event.sequence === source.sequence
            ? harness.deliveryRepository.markTerminalFailure({
                consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                eventSequence: event.sequence,
                expectedClaimOwner: "recovery-proof-owner",
                state: "uncertain",
                error: "Synthetic message delivery was not confirmed",
                updatedAt: now,
              })
            : harness.deliveryRepository.complete({
                consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                eventSequence: event.sequence,
                claimOwner: "recovery-proof-owner",
                completedAt: now,
              }),
        );
      }
      await Effect.runPromise(
        harness.deliveryRepository.advanceCursor({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: event.sequence,
          updatedAt: now,
        }),
      );
    }
    await harness.startReactor();
    const live = (turnId: string): ProviderSession => ({
      provider: "claudeAgent",
      status: "running",
      threadId,
      activeTurnId: asTurnId(turnId),
      runtimeMode: "approval-required",
      createdAt: now,
      updatedAt: now,
    });
    const receipt = {
      controlRequestId: `command:${stopCommandId}`,
      observedLifecycleGeneration: "original-runtime",
      turnId: asTurnId("recovery-original"),
      ...(scenario !== "unfinished Stop" ? { retiredLifecycleGeneration: "retired-runtime" } : {}),
    };
    const target: ProviderRuntimeSessionStopTarget = {
      session: scenario.startsWith("live ")
        ? live(scenario === "live same-runtime T2" ? "recovery-T2" : "recovery-original")
        : null,
      lifecycleGeneration:
        scenario === "replacement generation" || scenario === "inherited new epoch"
          ? "replacement-runtime"
          : "retired-runtime",
      ...(scenario.startsWith("inherited ")
        ? { inheritedLifecycleGeneration: "retired-runtime" }
        : scenario !== "unproven absence"
          ? { stopControlReceipt: receipt }
          : {}),
    };
    if (scenario === "retained cleanup" || scenario === "inherited retained cleanup") {
      retained = [live("recovery-retained")];
    }
    harness.hasLiveRuntimeTasks.mockReturnValue(Effect.succeed(scenario === "remaining work"));
    harness.getRuntimeSessionStopTarget.mockReturnValue(Effect.succeed(target));
    if (scenario === "failed observation") {
      harness.getRuntimeSessionStopTarget.mockReturnValue(
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "stop-target",
            detail: "Synthetic observation failed",
          }),
        ),
      );
    } else if (scenario === "changed after observation") {
      harness.getRuntimeSessionStopTarget.mockImplementationOnce(() => Effect.succeed(target));
      harness.getRuntimeSessionStopTarget.mockReturnValue(
        Effect.succeed({ ...target, session: live("recovery-T2") }),
      );
    } else if (scenario === "inherited acquired during observation") {
      harness.getRuntimeSessionStopTarget.mockImplementationOnce(() => Effect.succeed(target));
      harness.getRuntimeSessionStopTarget.mockReturnValue(
        Effect.succeed({
          session: null,
          lifecycleGeneration: target.lifecycleGeneration,
        }),
      );
    }
    harness.getRuntimeSessionStopTarget.mockClear();
    const recover = () =>
      Effect.runPromise(
        harness.reactor.reconcileDelivery({
          threadId,
          eventSequence: source.sequence,
          expectedState: "uncertain",
          outcome: "abandon",
          reconciledBy: "test-explicit-recovery",
        }),
      );
    if (reason === null) {
      expect(await recover()).toMatchObject({ state: "succeeded", outcome: "abandon" });
    } else {
      const failure = await recover().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderDeliveryRecoveryError);
      expect(failure).toMatchObject({ reason });
      const blocker = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getDelivery({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: source.sequence,
          }),
        ),
      );
      expect(blocker).toMatchObject({ state: "uncertain", attemptCount: 1 });
    }
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    if (scenario === "known child owner") {
      expect(harness.getRuntimeSessionStopTarget).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "drains a queued follower after a promoted Claude steer goes stale (replacement live: %s)",
    async (replacementLive) => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
        ingestRuntimeEvents: true,
        startReactor: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.startSession(threadId, {
          threadId,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
          cwd: "/tmp/provider-project",
          modelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
        }),
      );
      const queuedRequests = [];
      for (const [messageId, text, dispatchMode] of [
        ["promoted-stale-steer", "Old redirect", "steer"],
        ["stale-steer-follower", "Follow after the stale redirect", "queue"],
      ] as const) {
        const requested = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`cmd-${messageId}`),
            threadId,
            message: { messageId: asMessageId(messageId), role: "user", text, attachments: [] },
            dispatchMode,
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: now,
          }),
        );
        queuedRequests.push({
          queuedEventSequence: requested.sequence,
          threadId,
          messageId,
          dispatchMode,
          createdAt: now,
        });
      }
      // Recover persisted queued work without replaying its original deliveries.
      const events = Array.from(
        await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
      );
      for (const event of events) {
        await Effect.runPromise(
          harness.deliveryRepository.advanceCursor({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: event.sequence,
            updatedAt: now,
          }),
        );
      }
      const originalTurnId = asTurnId("promoted-stale-original");
      const replacementTurnId = asTurnId("promoted-stale-replacement");
      // The promotion wins its reservation just before another turn becomes live.
      harness.interceptEngineDispatch((command) => {
        if (
          command.type === "thread.turn.dispatch-queued" &&
          command.messageId === "promoted-stale-steer"
        ) {
          harness.setRuntimeSessionTurnState({
            threadId,
            status: "running",
            runtimeMode: "approval-required",
            activeTurnId: originalTurnId,
          });
        }
        return undefined;
      });
      let release!: () => void;
      const preparing = new Promise<void>((resolve) => {
        release = resolve;
      });
      harness.steerTurn.mockImplementationOnce(() =>
        Effect.promise(() => preparing).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterValidationError({
                provider: "claudeAgent",
                operation: "turn/steer.stale",
                issue: "The original turn ended before this message could be sent.",
              }),
            ),
          ),
        ),
      );
      try {
        await harness.startReactor();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("cmd-promoted-stale-ready"),
            threadId,
            session: {
              threadId,
              providerName: "claudeAgent",
              providerInstanceId: "claudeAgent",
              status: "ready",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
            createdAt: now,
          }),
        );
        await harness.drain();
        for (const request of queuedRequests) {
          await Effect.runPromise(harness.queuedTurnPromotionRepository.enqueue(request));
        }
        await emitHarnessTurnTerminal(harness, {
          eventId: "promoted-stale-previous-completed",
          provider: "claudeAgent",
          type: "completed",
          turnId: asTurnId("promoted-stale-previous"),
        });
        await waitFor(() => harness.steerTurn.mock.calls.length === 1);
        harness.setRuntimeSessionTurnState({
          threadId,
          status: replacementLive ? "running" : "ready",
          ...(replacementLive ? { activeTurnId: replacementTurnId } : {}),
        });
        await emitHarnessTurnTerminal(harness, {
          eventId: "promoted-stale-original-completed",
          provider: "claudeAgent",
          type: "completed",
          turnId: originalTurnId,
        });
        release();
        await harness.drain();
        if (replacementLive) {
          expect(harness.sendTurn).not.toHaveBeenCalled();
          harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
          await emitHarnessTurnTerminal(harness, {
            eventId: "promoted-stale-replacement-completed",
            provider: "claudeAgent",
            type: "completed",
            turnId: replacementTurnId,
          });
        }
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await harness.drain();
        expect(harness.steerTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          threadId,
          input: "Follow after the stale redirect",
        });
        expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
      } finally {
        release();
      }
    },
  );

  it("rejects a stale Claude steer without clearing its replacement turn or retrying delivery", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      ingestRuntimeEvents: true,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    await dispatchHarnessUserTurn(harness, {
      messageId: "before-stale-steer",
      text: "Initial task",
      createdAt: new Date().toISOString(),
    });
    await harness.drain();
    const firstTurnId = asTurnId("stale-steer-original");
    harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: firstTurnId });
    await harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: asEventId("stale-steer-original-started"),
      provider: "claudeAgent",
      threadId,
      turnId: firstTurnId,
      createdAt: new Date().toISOString(),
      payload: {},
      providerRefs: {},
    });
    await waitFor(
      async () => (await readHarnessThread(harness))?.session?.activeTurnId === firstTurnId,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.steerTurn.mockImplementationOnce(() =>
      Effect.promise(() => gate).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapterValidationError({
              provider: "claudeAgent",
              operation: "turn/steer.stale",
              issue: "The original turn ended before this message could be sent.",
            }),
          ),
        ),
      ),
    );
    try {
      const response = await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("stale-steer-request"),
          threadId,
          message: {
            messageId: asMessageId("stale-steer-message"),
            role: "user",
            text: "Old redirect",
            attachments: [],
          },
          dispatchMode: "steer",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => harness.steerTurn.mock.calls.length === 1);
      const replacementTurnId = asTurnId("stale-steer-replacement");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        activeTurnId: replacementTurnId,
      });
      const before = (await readHarnessThread(harness))!.session!;
      const replacement = {
        ...before,
        status: "running" as const,
        activeTurnId: replacementTurnId,
        updatedAt: "2099-01-01T00:00:00.000Z",
        lastError: null,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("stale-steer-replacement-projected"),
          threadId,
          session: replacement,
          createdAt: replacement.updatedAt,
        }),
      );
      release();
      await harness.drain();
      expect((await readHarnessThread(harness))?.session).toEqual(replacement);
      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
      expect(
        Option.getOrThrow(
          await Effect.runPromise(
            harness.deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: response.sequence,
            }),
          ),
        ),
      ).toMatchObject({ state: "succeeded", attemptCount: 1 });
      expect((await readHarnessThread(harness))?.activities).toContainEqual(
        expect.objectContaining({
          kind: "provider.turn.start.failed",
          turnId: null,
          payload: expect.objectContaining({
            detail: expect.stringContaining("original turn ended"),
          }),
        }),
      );
    } finally {
      release();
    }
  });

  for (const interveningEvent of [false, true]) {
    it(`restores only its own optimistic state after a busy Claude rejection (concurrent event: ${interveningEvent})`, async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      const send = (id: string, options?: { autoCompactWindow: string }) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(id),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text: "continue", attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
          ...(options
            ? {
                modelSelection: {
                  provider: "claudeAgent" as const,
                  model: "claude-fable-5-1",
                  options,
                },
              }
            : {}),
        });
      await Effect.runPromise(send("bootstrap-busy"));
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const prior = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!.session!;
      harness.sendTurn.mockClear();
      harness.startSession.mockImplementationOnce(() =>
        Effect.gen(function* () {
          if (interveningEvent) {
            yield* harness.engine
              .dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe("late-runtime-event"),
                threadId,
                session: {
                  ...prior,
                  status: "running",
                  activeTurnId: asTurnId("late-turn"),
                  updatedAt: "2099-01-01T00:00:00.000Z",
                },
                createdAt: "2099-01-01T00:00:00.000Z",
              })
              .pipe(Effect.orDie);
          }
          return yield* new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "session/reconfigure",
            issue: "Background work is active",
          });
        }),
      );
      await Effect.runPromise(send("rejected-busy", { autoCompactWindow: "200k" }));
      await harness.drain();
      const after = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!.session!;
      expect(after).toMatchObject(
        interveningEvent
          ? { status: "running", activeTurnId: "late-turn" }
          : {
              status: "ready",
              activeTurnId: null,
              runtimeMode: prior.runtimeMode,
              lastError: "Your message was not sent. Background work is active",
            },
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
    });
  }

  it("defers switching Computer off while Claude still has background work", async () => {
    const registry = makeAgentGatewaySessionRegistry();
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-fable-5-1" },
      gatewaySessions: registry,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = new Date().toISOString();
    const send = (id: string) =>
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(id),
        threadId,
        message: { messageId: asMessageId(id), role: "user", text: "continue", attachments: [] },
        enableComputerControl: false,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      });
    await Effect.runPromise(send("bootstrap-computer"));
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    // The previous turn ran with Computer on; this one turns it off.
    registry.issue(threadId, "claudeAgent", { additionalCapabilities: ["computer:control"] });
    harness.startSession.mockClear();
    harness.startSession.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "session/reconfigure",
          issue: "Background work is active",
        }),
      ),
    );
    await Effect.runPromise(send("computer-off-busy"));
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).not.toHaveBeenCalled();
    const session = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!.session!;
    expect(session.lastError).toBeNull();
  });

  it("seeds imported Droid selection and applies a stored effort at the next turn", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "droid",
        model: "claude-sonnet-4-6",
        options: { reasoningEffort: "medium" },
      },
    });
    const now = new Date().toISOString();

    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "ready",
      runtimeMode: "approval-required",
    });
    await setHarnessSession(harness, {
      commandId: "cmd-session-set-imported-droid",
      status: "ready",
      providerName: "droid",
      at: now,
    });
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

    await harness.drain();
    expect(harness.startSession).not.toHaveBeenCalled();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-imported-droid",
      messageId: "user-message-imported-droid",
      text: "continue on droid",
      createdAt: now,
    });
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

  it("applies the Debug prompt once while preserving interaction and runtime modes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "antigravity",
        model: "Gemini 3.5 Flash",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-debug"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-debug"),
          role: "user",
          text: "reproduce the crash",
          attachments: [],
        },
        interactionMode: "debug",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: "approval-required",
    });
    const turnInput = harness.sendTurn.mock.calls[0]?.[0] as {
      readonly input?: string;
      readonly interactionMode?: string;
    };
    expect(turnInput.interactionMode).toBe("debug");
    expect(turnInput.input).toContain("reproduce the crash");
    expect(turnInput.input?.split(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)).toHaveLength(2);
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
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    });
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged and cwd is omitted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-unchanged-1",
      messageId: "user-message-unchanged-1",
      text: "first",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sessions = await Effect.runPromise(harness.listSessions());
    harness.listSessions.mockReturnValue(
      Effect.succeed(
        sessions.map(({ cwd, ...session }) => {
          void cwd;
          return session;
        }),
      ),
    );
    harness.hasLiveRuntimeTasks.mockReturnValue(Effect.succeed(true));

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-unchanged-2",
      messageId: "user-message-unchanged-2",
      text: "second",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it.each([
    {
      coordinatorThreadIds: ["thread-1"] as readonly string[],
      coordinatorConfigState: undefined,
      label: "active",
      expected: true,
    },
    {
      coordinatorThreadIds: ["thread-1"] as readonly string[],
      coordinatorConfigState: undefined,
      label: "Stable saved coordinator",
      groupsEnabled: false,
      expected: false,
    },
    {
      coordinatorThreadIds: ["thread-1"] as readonly string[],
      coordinatorConfigState: { pausedAt: new Date(0).toISOString() },
      label: "paused",
      expected: false,
    },
    {
      coordinatorThreadIds: ["thread-1"] as readonly string[],
      coordinatorConfigState: { archivedAt: new Date(0).toISOString() },
      label: "archived",
      expected: false,
    },
    {
      coordinatorThreadIds: ["thread-1"] as readonly string[],
      coordinatorConfigState: { enabled: false },
      label: "disabled",
      expected: false,
    },
    {
      coordinatorThreadIds: [] as readonly string[],
      coordinatorConfigState: undefined,
      label: "non-coordinator",
      expected: false,
    },
  ])(
    "pre-approves Synara group tools only for an active coordinator session ($label: $expected)",
    async ({ coordinatorThreadIds, coordinatorConfigState, label, expected, groupsEnabled }) => {
      vi.spyOn(groupsBetaGate, "isServerGroupsEnabled").mockReturnValue(groupsEnabled ?? true);
      const harness = await createHarness({ coordinatorThreadIds, coordinatorConfigState });
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        commandId: `cmd-turn-start-autoapprove-${label}`,
        messageId: `user-message-autoapprove-${label}`,
        text: "delegate this",
        createdAt: now,
      });

      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const startInput = harness.startSession.mock.calls[0]?.[1];
      if (expected) {
        expect(startInput).toMatchObject({ autoApproveSynaraTools: true });
      } else {
        expect(startInput).not.toHaveProperty("autoApproveSynaraTools");
      }
      // File edits and shell still ask: the flag must never widen into
      // blanket approval, so it travels as a dedicated start option and not
      // through the runtime mode.
      expect(startInput).toMatchObject({ runtimeMode: "approval-required" });
    },
  );

  it("restarts a live coordinator session when the group loses the flag", async () => {
    const coordinatorConfigState: {
      enabled?: boolean;
      pausedAt?: string | null;
      archivedAt?: string | null;
    } = {};
    const harness = await createHarness({
      coordinatorThreadIds: ["thread-1"],
      coordinatorConfigState,
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-flag-1",
      messageId: "user-message-flag-1",
      text: "first turn",
      createdAt: now,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      autoApproveSynaraTools: true,
    });

    // The group is paused between turns: the running session was provisioned
    // with the flag, so the next turn must restart it rather than keep a
    // runtime that silently still pre-approves the Synara tools.
    coordinatorConfigState.pausedAt = new Date(0).toISOString();
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-flag-2",
      messageId: "user-message-flag-2",
      text: "second turn",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("autoApproveSynaraTools");
  });

  it.each([
    { provider: "grok", model: "grok-code-fast-1", target: "claude-sonnet-4-6" },
    { provider: "devin", model: "swe-1.7", target: "claude-opus-5-5" },
  ] as const)(
    "rebinds a stored $provider-to-Claude provider change, dropping the resume cursor and keeping the transcript bootstrap",
    async ({ provider, model, target }) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model },
      });
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: `user-message-${provider}-rebind-1`,
        text: `first turn on ${provider}`,
        createdAt: now,
      });
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        modelSelection: { provider, model },
      });

      // Group settings applies a new coordinator model by writing the stored
      // selection durably; the next turn must rebind rather than error.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`cmd-${provider}-rebind-meta-update`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          modelSelection: { provider: "claudeAgent", model: target },
        }),
      );

      await dispatchHarnessUserTurn(harness, {
        messageId: `user-message-${provider}-rebind-2`,
        text: "now on claude",
        createdAt: now,
      });

      await waitFor(() => harness.startSession.mock.calls.length === 2);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        provider: "claudeAgent",
        modelSelection: { provider: "claudeAgent", model: target },
      });
      // The prior provider's resume cursor is meaningless to Claude: dropped, with the
      // prior-transcript bootstrap standing in for continuity (Hand off's
      // mechanism), so the second sendTurn carries the thread context.
      expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain(`first turn on ${provider}`);

      const thread = await readHarnessThread(harness);
      expect(thread?.session?.providerName).toBe("claudeAgent");
    },
  );

  it("passes unresolved Devin stop outcomes and live tasks into provider session startup", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "devin", model: "swe-1.7" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const appendActivity = (
      id: string,
      taskId: string,
      status: string,
      createdAt: string,
      extra: Record<string, unknown> = {},
      ownerId = threadId,
      turnId: TurnId | null = null,
      kind = "task.completed",
    ) =>
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`cmd-${id}`),
        threadId: ownerId,
        activity: {
          id: EventId.makeUnsafe(id),
          kind,
          tone: "info",
          summary: `Task ${status}`,
          payload: { taskId, status, ...extra },
          turnId,
          createdAt,
        },
        createdAt,
      });

    await Effect.runPromise(
      appendActivity("pending-stop-1", "shell-pending", "stopped", "2026-10-11T00:00:01.000Z", {
        awaitingProviderConfirmation: true,
      }),
    );
    await Effect.runPromise(
      appendActivity("ordinary-stop-2", "shell-ordinary", "stopped", "2026-10-11T00:00:02.000Z"),
    );
    await Effect.runPromise(
      appendActivity(
        "already-corrected-3",
        "shell-corrected",
        "completed",
        "2026-10-11T00:00:03.000Z",
        { reconcilesStop: true },
      ),
    );

    for (const [id, parentId, agentId] of [
      ["nested-parent", "thread-1", "parent-agent"],
      ["nested-owner", "nested-parent", "nested-agent"],
      ["unrelated-owner", null, "unrelated-agent"],
      ["independent-owner", "thread-1", "independent-agent"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create-${id}`),
          threadId: ThreadId.makeUnsafe(id),
          projectId: asProjectId("project-1"),
          title: id,
          modelSelection: { provider: "devin", model: "swe-1.7" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThreadId: parentId ? ThreadId.makeUnsafe(parentId) : null,
          subagentAgentId: agentId,
          creationSource: "provider_native",
          createdAt: new Date().toISOString(),
        }),
      );
    }
    // A linked child with its own runtime does not belong to this Devin session.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("independent-owner-session"),
        threadId: ThreadId.makeUnsafe("independent-owner"),
        session: {
          threadId: ThreadId.makeUnsafe("independent-owner"),
          status: "ready",
          providerName: "devin",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-10-11T00:00:03.000Z",
        },
        createdAt: "2026-10-11T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(
      appendActivity(
        "independent-stop",
        "independent-task",
        "stopped",
        "2026-10-11T00:00:03.000Z",
        { awaitingProviderConfirmation: true },
        ThreadId.makeUnsafe("independent-owner"),
      ),
    );
    await Effect.runPromise(
      appendActivity(
        "nested-stop",
        "nested-task",
        "stopped",
        "2026-10-11T00:00:04.000Z",
        { awaitingProviderConfirmation: true, toolUseId: "nested-tool" },
        ThreadId.makeUnsafe("nested-owner"),
        asTurnId("original-nested-turn"),
      ),
    );
    await Effect.runPromise(
      appendActivity(
        "unrelated-stop",
        "unrelated-task",
        "stopped",
        "2026-10-11T00:00:05.000Z",
        { awaitingProviderConfirmation: true },
        ThreadId.makeUnsafe("unrelated-owner"),
      ),
    );

    await Effect.runPromise(
      appendActivity(
        "still-running",
        "live-agent",
        "running",
        "2026-10-11T00:00:06.000Z",
        { toolUseId: "live-tool", interactionMode: "plan" },
        threadId,
        asTurnId("live-launch-turn"),
        "task.started",
      ),
    );
    // The same durable retirement used at boot must keep native replay correlation.
    const beforeRestart = await readHarnessThread(harness);
    if (!beforeRestart) throw new Error("Missing Devin thread before restart cleanup");
    const retirementCommands = planRestartTurnReconciliation({
      threads: [beforeRestart],
      now: "2026-10-11T00:02:00.000Z",
      retireTasksStartedBefore: "2026-10-11T00:01:00.000Z",
    });
    expect(retirementCommands).toHaveLength(1);
    for (const command of retirementCommands) {
      await Effect.runPromise(harness.engine.dispatch(command));
    }
    // Session shutdown can record an ordinary local stop even though the
    // remote Devin child survives. Repeated native resumes must retain its
    // original Plan launch identity rather than the newer parent's policy.
    for (const attempt of [1, 2]) {
      await Effect.runPromise(
        appendActivity(
          `resumed-live-${attempt}`,
          "live-agent",
          "running",
          `2026-10-11T00:02:0${attempt * 2}.000Z`,
          { reconcilesStop: true, toolUseId: "live-tool" },
          threadId,
          null,
          "task.updated",
        ),
      );
      await Effect.runPromise(
        appendActivity(
          `session-stop-live-${attempt}`,
          "live-agent",
          "stopped",
          `2026-10-11T00:02:0${attempt * 2 + 1}.000Z`,
          { toolUseId: "live-tool" },
        ),
      );
    }
    await dispatchHarnessUserTurn(harness, {
      messageId: "message-devin-pending-stop",
      text: "resume Devin",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "devin",
      pendingTaskReconciliations: [
        { taskId: "shell-pending" },
        {
          taskId: "live-agent",
          toolUseId: "live-tool",
          turnId: "live-launch-turn",
          interactionMode: "plan",
        },
        {
          taskId: "nested-task",
          turnId: "original-nested-turn",
          toolUseId: "nested-tool",
          parentAgentId: "nested-agent",
        },
      ],
    });
  });

  it.each([
    { provider: "claudeAgent", model: "claude-opus-5-5" },
    { provider: "cursor", model: "auto" },
    { provider: "pi", model: "model-a" },
    { provider: "droid", model: "model-a" },
    { provider: "antigravity", model: "model-a" },
    { provider: "omp", model: "model-a" },
  ] as const)(
    "carries a stored Codex-to-$provider transcript once after target acceptance",
    async (selection) => {
      const harness = await createHarness();
      const now = new Date().toISOString();

      await dispatchHarnessUserTurn(harness, {
        messageId: "user-message-codex-rebind-1",
        text: "first turn on codex",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      // A plain model save (not Hand off) moves the stored selection to the target.
      // ProviderService refuses to drop Codex history unless the start says so.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-codex-rebind-meta-update"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          modelSelection: selection,
        }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "user-message-codex-rebind-2",
        text: `now on ${selection.provider}`,
        createdAt: now,
      });

      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      const rebindStart = harness.startSessionWithOutcome.mock.calls.find(
        ([, startInput]) => startInput.provider === selection.provider,
      );
      expect(rebindStart?.[2]).toMatchObject({ abandonOtherProviderContinuation: true });
      expect(rebindStart?.[1]).not.toHaveProperty("resumeCursor");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on codex");
      expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();
      await emitHarnessTurnTerminal(harness, {
        eventId: `${selection.provider}-rebind-completed`,
        provider: selection.provider,
        type: "completed",
      });
      await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
      expect(harness.pendingPriorTranscriptBootstraps.has(ThreadId.makeUnsafe("thread-1"))).toBe(
        false,
      );

      await Effect.runPromise(
        harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
      );
      await dispatchHarnessUserTurn(harness, {
        messageId: "user-message-codex-rebind-3",
        text: "Continue after idle.",
        createdAt: now,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      expect(harness.sendTurn.mock.calls[2]?.[0].input).toBe("Continue after idle.");
    },
  );

  it("does not let an old lifecycle retry retire a newly rebound provider's transcript", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    const previousTurnId = asTurnId("old-provider-recovery-turn");
    const initialAppend = Promise.withResolvers<void>();
    let releasePreviousActivity = false;
    let previousActivityAttempts = 0;
    harness.interceptEngineDispatch((command) => {
      if (
        command.type !== "thread.activity.append" ||
        command.activity.kind !== "provider.context.changed" ||
        command.activity.turnId !== previousTurnId
      ) {
        return undefined;
      }
      previousActivityAttempts += 1;
      if (previousActivityAttempts === 1) {
        return Effect.promise(() => initialAppend.promise).pipe(
          Effect.andThen(
            Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "The old activity append fails after the new attempt has registered.",
              }),
            ),
          ),
        );
      }
      return releasePreviousActivity
        ? undefined
        : Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Hold the previous provider's recovery evidence until after rebind.",
            }),
          );
    });
    await dispatchHarnessUserTurn(harness, {
      messageId: "rebind-retry-seed",
      text: "Preserve this context across provider changes.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.succeed({ threadId, turnId: previousTurnId }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("rebind-retry-opencode-selection"),
        threadId,
        modelSelection: { provider: "opencode", model: "openai/gpt-5" },
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "rebind-retry-opencode-turn",
      text: "Continue in OpenCode.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await emitHarnessTurnTerminal(harness, {
      eventId: "rebind-retry-opencode-completed",
      provider: "opencode",
      type: "completed",
      turnId: previousTurnId,
    });
    await waitFor(() => previousActivityAttempts > 0);
    expect(harness.completePriorTranscriptBootstrap).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("rebind-retry-claude-selection"),
        threadId,
        modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "rebind-retry-claude-turn",
      text: "Continue in Claude before its turn settles.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
    initialAppend.resolve();
    await waitFor(() => previousActivityAttempts > 1);
    releasePreviousActivity = true;
    await waitFor(async () =>
      Boolean(
        (await readHarnessThread(harness))?.activities.some(
          (activity) =>
            activity.kind === "provider.context.changed" && activity.turnId === previousTurnId,
        ),
      ),
    );
    await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 1);
    expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(true);
    await emitHarnessTurnTerminal(harness, {
      eventId: "rebind-retry-claude-failed",
      provider: "claudeAgent",
      type: "failed",
    });
    await harness.drain();
    await dispatchHarnessUserTurn(harness, {
      messageId: "rebind-retry-claude-retry-turn",
      text: "Retry the new provider's recovery.",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 4);
    expect(harness.sendTurn.mock.calls[3]?.[0].input).toContain("<thread_context>");
    expect(harness.sendTurn.mock.calls[3]?.[0].input).toContain(
      "Preserve this context across provider changes.",
    );
    await emitHarnessTurnTerminal(harness, {
      eventId: "rebind-retry-claude-completed",
      provider: "claudeAgent",
      type: "completed",
    });
    await waitFor(() => harness.completePriorTranscriptBootstrap.mock.calls.length === 2);
    expect(harness.pendingPriorTranscriptBootstraps.has(threadId)).toBe(false);
  });

  it("refuses a stored provider switch that would end running background tasks", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-rebind-tasks-1",
      text: "first turn on codex",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.hasLiveRuntimeTasks.mockReturnValue(Effect.succeed(true));

    // Only Hand off may stop background tasks, after the user agrees to.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-rebind-tasks-meta-update"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
      }),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-rebind-tasks-2",
      text: "now on claude",
      createdAt: now,
    });

    await waitFor(async () =>
      ((await readHarnessThread(harness))?.activities ?? []).some(
        (activity) =>
          activity.kind === "provider.turn.start.failed" &&
          JSON.stringify(activity.payload).includes("before switching providers"),
      ),
    );
    expect(
      harness.startSession.mock.calls.some(([, input]) => input.provider === "claudeAgent"),
    ).toBe(false);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
  });

  it("clears a stale Claude resume cursor surfaced asynchronously and retries fresh once", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-stale-resume-1",
      text: "first turn on claude",
      createdAt: now,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // The Claude session dies while the persisted cursor remains, so the next
    // dispatch resumes from it. The CLI accepts --resume at spawn, so the
    // stale id only fails once the queued prompt reaches it — the failure
    // arrives as an async terminal event, not a sendTurn rejection.
    await Effect.runPromise(harness.stopRuntimeSession({ threadId }));

    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-stale-resume-2",
      text: "second turn resumes claude",
      createdAt: now,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    await harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: asEventId("evt-stale-resume-failed"),
      provider: "claudeAgent",
      threadId,
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage:
          "Claude Code returned an error result: No conversation found with session ID: dead-session-id",
      },
      providerRefs: {},
    } as ProviderRuntimeEvent);
    await waitFor(() => harness.clearSessionResumeCursor.mock.calls.length === 1);
    expect(harness.clearSessionResumeCursor.mock.calls[0]?.[0]).toMatchObject({ threadId });

    // The next dispatch must start a fresh native session instead of
    // replaying the dead resume id, with the transcript bootstrap carrying
    // the earlier context.
    await dispatchHarnessUserTurn(harness, {
      messageId: "user-message-stale-resume-3",
      text: "retry turn",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 3);
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[2]?.[0].input).toContain("<thread_context>");
    expect(harness.sendTurn.mock.calls[2]?.[0].input).toContain("first turn on claude");
  });

  it("applies a stored provider rebind deferred behind an in-flight turn", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-deferred-1",
      messageId: "user-message-deferred-1",
      text: "first turn on grok",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // Turn in flight: the settings save must not tear it down — the rebind
    // waits for the turn boundary.
    await setHarnessSession(harness, {
      commandId: "cmd-deferred-session-running",
      status: "running",
      providerName: "grok",
      activeTurnId: asTurnId("turn-deferred-live"),
      at: now,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-meta-deferred-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(harness.startSession.mock.calls.length).toBe(1);

    // The turn ends on the old provider; the projected row settles ready.
    await setHarnessSession(harness, {
      commandId: "cmd-deferred-session-ready",
      status: "ready",
      providerName: "grok",
      at: now,
    });

    // The next bare turn's turn-start-requested repaints the projected
    // providerName to the stored selection BEFORE ensure runs — detecting the
    // rebind requires the provider the session was actually spawned with (the
    // live session / recorded spawn selection), not the optimistic row.
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-deferred-2",
      messageId: "user-message-deferred-2",
      text: "now on claude",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.providerName).toBe("claudeAgent");
  });

  it("rebinds across a stopped session and still carries the transcript", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-stopped-rebind-1",
      messageId: "user-message-stopped-rebind-1",
      text: "first turn on grok",
      createdAt: now,
    });
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // The coordinator's session is gone when the settings save lands — an
    // explicit stop even suppresses synthetic context on the next start. A
    // provider rebind is the one start that must ignore that suppression,
    // because the new provider cannot resume the old history natively.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-stopped-rebind-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );
    await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");

    // Group settings writes the new coordinator model durably. With no live
    // session, nothing applies the selection now — the recorded spawn
    // selection must keep reading 'grok' so the next turn sees the rebind.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-stopped-rebind-meta-update"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-stopped-rebind-2",
      messageId: "user-message-stopped-rebind-2",
      text: "now on claude",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
    expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.providerName).toBe("claudeAgent");
  });

  describe("same-thread provider handoff", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    async function runFirstGrokTurn(harness: Awaited<ReturnType<typeof createHarness>>) {
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-handoff-turn-1"),
          threadId,
          message: {
            messageId: asMessageId("user-message-handoff-1"),
            role: "user",
            text: "first turn on grok",
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
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-handoff-session-ready"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "grok",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    }

    const dispatchHandoff = (harness: Awaited<ReturnType<typeof createHarness>>) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-handoff-to-claude"),
          threadId,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          providerHandoff: true,
        }),
      );

    const sendSecondTurn = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      enableComputerControl?: boolean,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-handoff-turn-2"),
          threadId,
          message: {
            messageId: asMessageId("user-message-handoff-2"),
            role: "user",
            text: "continue after the handoff",
            attachments: [],
          },
          ...(enableComputerControl !== undefined ? { enableComputerControl } : {}),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );

    it("starts the target in the same thread and carries context through computer control activation", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      const before = await readHarnessThread(harness);

      await dispatchHandoff(harness);

      // The target session starts now, before any new message is sent, and only
      // after the source's protected native continuation was reset.
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({ threadId });
      expect(harness.clearSessionResumeCursor.mock.invocationCallOrder.at(-1)).toBeLessThan(
        harness.startSession.mock.invocationCallOrder[1]!,
      );
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        provider: "claudeAgent",
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      });
      await waitFor(async () =>
        Boolean(
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.handoff",
          ),
        ),
      );

      const after = await readHarnessThread(harness);
      const handoffActivity = after?.activities.find(
        (activity) => activity.kind === "provider.handoff",
      );
      // Keyed by the requesting command so the client can await this outcome.
      expect(handoffActivity?.id).toBe("provider-handoff:cmd-handoff-to-claude");
      expect(handoffActivity?.payload).toMatchObject({
        sourceProvider: "grok",
        sourceModel: "grok-code-fast-1",
        targetProvider: "claudeAgent",
        targetModel: "claude-sonnet-4-6",
      });
      expect((handoffActivity?.payload as { contextText: string }).contextText).toContain(
        "first turn on grok",
      );
      // Same Synara thread: id, transcript, project, and workspace survive.
      expect(after?.id).toBe(threadId);
      expect(after?.projectId).toBe(before?.projectId);
      expect(after?.worktreePath).toBe(before?.worktreePath);
      expect(after?.branch).toBe(before?.branch);
      expect(after?.messages.map((message) => [message.id, message.text, message.source])).toEqual(
        before?.messages.map((message) => [message.id, message.text, message.source]),
      );
      expect(after?.modelSelection).toMatchObject({ provider: "claudeAgent" });
      expect(after?.session?.providerName).toBe("claudeAgent");
      // Same "handed off from" metadata a new-thread handoff carries.
      await waitFor(async () => (await readHarnessThread(harness))?.handoff !== null);
      expect((await readHarnessThread(harness))?.handoff).toMatchObject({
        sourceThreadId: threadId,
        sourceProvider: "grok",
        bootstrapStatus: "completed",
      });

      // The next turn runs on the target and carries the prior transcript.
      await sendSecondTurn(harness, true);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession.mock.calls).toHaveLength(3);
      expect(harness.startSession.mock.calls.at(-1)?.[1].enableComputerControl).toBe(true);
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");
      // The handoff divider explains the fresh session; no lost-history notice.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        (await readHarnessThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.context.changed",
        ),
      ).toBe(false);
    });

    it("starts the target and carries context when the source session was stopped", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-handoff-stop"),
          threadId,
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "stopped");

      await dispatchHandoff(harness);
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({ provider: "claudeAgent" });

      await sendSecondTurn(harness);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");
    });

    it("restores the source selection and records a failure when the target cannot start", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "claudeAgent",
            threadId,
            reason: "startup-failed",
            detail: "Claude could not start.",
          }),
        ),
      );

      await dispatchHandoff(harness);

      await waitFor(async () =>
        Boolean(
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.handoff.failed",
          ),
        ),
      );
      const thread = await readHarnessThread(harness);
      expect(thread?.modelSelection).toMatchObject({
        provider: "grok",
        model: "grok-code-fast-1",
      });
      expect(thread?.activities.some((activity) => activity.kind === "provider.handoff")).toBe(
        false,
      );
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.handoff.failed"),
      ).toMatchObject({ id: "provider-handoff-failed:cmd-handoff-to-claude", tone: "error" });

      // The thread stays usable on the source provider.
      await sendSecondTurn(harness);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("continue after the handoff");
      // The source restarts fresh (its continuation was reset), so the turn
      // carries the transcript instead of losing the conversation.
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("<thread_context>");
      expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");
      expect(harness.sendTurn.mock.calls[1]?.[0].modelSelection).toMatchObject({
        provider: "grok",
      });
    });

    it.each([false, true])(
      "settles a handoff rejected by an earlier quarantined delivery (outcome write fails: %s)",
      async (failOutcomeWrite) => {
        const harness = await createHarness({
          threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
        });
        await runFirstGrokTurn(harness);
        harness.sendTurn.mockImplementationOnce(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "grok",
              method: "turn/start",
              detail: "connection closed after request write",
            }),
          ),
        );
        await sendSecondTurn(harness);
        await waitFor(async () =>
          Option.isSome(
            await Effect.runPromise(
              harness.deliveryRepository.firstBlockingDeliveryForThread({
                consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                threadId,
              }),
            ),
          ),
        );

        if (failOutcomeWrite) {
          harness.interceptEngineDispatch((command) =>
            command.commandId === "server:provider-handoff-failed:cmd-handoff-to-claude"
              ? Effect.fail(
                  new PersistenceSqlError({
                    operation: "provider-handoff-outcome",
                    detail: "Injected durable outcome write failure.",
                  }),
                )
              : undefined,
          );
        }
        const handoff = await dispatchHandoff(harness);
        await waitFor(async () => {
          const cursor = await Effect.runPromise(
            harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
          );
          return (Option.getOrUndefined(cursor)?.lastAckedSequence ?? 0) >= handoff.sequence;
        });
        const thread = await readHarnessThread(harness);
        const failure = thread?.activities.find(
          (activity) => activity.id === "provider-handoff-failed:cmd-handoff-to-claude",
        );
        if (failOutcomeWrite) {
          expect(failure).toBeUndefined();
        } else {
          expect(failure).toMatchObject({ kind: "provider.handoff.failed" });
        }
        expect(thread?.modelSelection.provider).toBe("grok");
        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
        expect(
          await Effect.runPromise(
            harness.deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: handoff.sequence,
            }),
          ),
        ).toMatchObject({
          _tag: "Some",
          value: { state: failOutcomeWrite ? "uncertain" : "succeeded", attemptCount: 1 },
        });
      },
    );

    it("preserves a newer model choice when a failed handoff tries to restore its source", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "claudeAgent",
            threadId,
            reason: "startup-failed",
            detail: "Target startup failed",
          }),
        ),
      );

      const dispatch = harness.engine.dispatch;
      const newSelection = { provider: "codex", model: "gpt-6" } as const;
      harness.interceptEngineDispatch((command) =>
        command.commandId === "server:provider-handoff-revert:cmd-handoff-to-claude"
          ? dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("cmd-newer-model-choice"),
              threadId,
              modelSelection: newSelection,
            }).pipe(Effect.andThen(Effect.suspend(() => dispatch(command))))
          : undefined,
      );

      const handoff = await dispatchHandoff(harness);
      await waitFor(async () => {
        const cursor = await Effect.runPromise(
          harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
        );
        return (Option.getOrUndefined(cursor)?.lastAckedSequence ?? 0) >= handoff.sequence;
      });
      const thread = await readHarnessThread(harness);
      expect(thread?.modelSelection).toMatchObject(newSelection);
      const failure = thread?.activities.find(
        (activity) => activity.id === "provider-handoff-failed:cmd-handoff-to-claude",
      );
      expect(failure).toMatchObject({ kind: "provider.handoff.failed" });
      expect(failure?.summary).not.toContain("the thread stays on");
      expect(harness.startSession).toHaveBeenCalledTimes(2);
    });

    it.each(["successful", "timed-out"] as const)(
      "settles a %s handoff after its durable write exceeds the provider deadline",
      async (result) => {
        const harness = await createHarness({
          threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
          commandEventTimeout: Duration.millis(300),
        });
        await runFirstGrokTurn(harness);
        if (result === "timed-out") {
          harness.startSession.mockImplementationOnce(() => Effect.never);
        }
        const settlementEntered = Deferred.makeUnsafe<void>();
        const releaseSettlement = Deferred.makeUnsafe<void>();
        const dispatch = harness.engine.dispatch;
        const settlementCommandId =
          result === "successful"
            ? "server:provider-handoff-meta:cmd-handoff-to-claude"
            : "server:provider-handoff-revert:cmd-handoff-to-claude";
        harness.interceptEngineDispatch((command) => {
          if (command.commandId !== settlementCommandId) return undefined;
          // Hold the real engine write after the bounded native phase. The
          // claim cannot be acknowledged or quarantined while this known
          // handoff outcome is still waiting for durable settlement.
          return Deferred.succeed(settlementEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSettlement)),
            Effect.andThen(Effect.suspend(() => dispatch(command))),
          );
        });
        const handoff = await dispatchHandoff(harness);
        const deliveryKey = {
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: handoff.sequence,
        };
        try {
          await waitFor(() => Effect.runPromise(Deferred.isDone(settlementEntered)));
          // Cross the configured 300ms provider deadline after the settlement
          // has begun; this does not grant more time to provider startup.
          await new Promise((resolve) => setTimeout(resolve, 350));
          const pending = Option.getOrThrow(
            await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
          );
          expect(pending).toMatchObject({ state: "inflight", attemptCount: 1 });
          const cursor = Option.getOrThrow(
            await Effect.runPromise(
              harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
            ),
          );
          expect(cursor.lastAckedSequence).toBeLessThan(handoff.sequence);
        } finally {
          await Effect.runPromise(Deferred.succeed(releaseSettlement, undefined));
        }
        await waitFor(async () => {
          const delivery = Option.getOrThrow(
            await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
          );
          return delivery.state === "succeeded";
        });
        const thread = await readHarnessThread(harness);
        const expectedProvider = result === "successful" ? "claudeAgent" : "grok";
        expect(thread?.modelSelection.provider).toBe(expectedProvider);
        expect(
          thread?.activities.filter((activity) => activity.kind.startsWith("provider.handoff")),
        ).toMatchObject([
          {
            kind: result === "successful" ? "provider.handoff" : "provider.handoff.failed",
          },
        ]);
        await sendSecondTurn(harness);
        await waitFor(() => harness.sendTurn.mock.calls.length === 2);
        expect(harness.sendTurn.mock.calls[1]?.[0].modelSelection?.provider).toBe(expectedProvider);
        expect(harness.sendTurn.mock.calls[1]?.[0].input).toContain("first turn on grok");
      },
    );

    it("does not replay a handoff when its durable outcome cannot be persisted", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      let settlementAttempts = 0;
      harness.interceptEngineDispatch((command) => {
        if (command.commandId !== "server:provider-handoff-meta:cmd-handoff-to-claude") {
          return undefined;
        }
        settlementAttempts += 1;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "provider-handoff-outcome",
            detail: "Injected durable outcome write failure.",
          }),
        );
      });
      const handoff = await dispatchHandoff(harness);
      const deliveryKey = {
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: handoff.sequence,
      };
      await waitFor(async () => {
        const delivery = Option.getOrUndefined(
          await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
        );
        return (
          delivery?.state === "uncertain" ||
          delivery?.state === "dead" ||
          delivery?.state === "succeeded"
        );
      });
      await harness.drain();
      expect(
        Option.getOrThrow(
          await Effect.runPromise(harness.deliveryRepository.getDelivery(deliveryKey)),
        ),
      ).toMatchObject({ state: "uncertain", attemptCount: 1 });
      expect(settlementAttempts).toBe(1);
      expect(harness.startSession).toHaveBeenCalledTimes(2);
      expect(harness.clearSessionResumeCursor).toHaveBeenCalledTimes(1);
      expect(
        (await readHarnessThread(harness))?.activities.some((activity) =>
          activity.kind.startsWith("provider.handoff"),
        ),
      ).toBe(false);
    });

    it("keeps the source runtime while background tasks are still active", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      harness.hasLiveRuntimeTasks.mockReturnValue(Effect.succeed(true));

      await dispatchHandoff(harness);
      await waitFor(async () =>
        Boolean(
          (await readHarnessThread(harness))?.activities.some(
            (activity) =>
              activity.kind === "provider.handoff.failed" || activity.kind === "provider.handoff",
          ),
        ),
      );

      const thread = await readHarnessThread(harness);
      expect(
        thread?.activities.find((activity) => activity.kind.startsWith("provider.handoff"))?.kind,
      ).toBe("provider.handoff.failed");
      expect(thread?.modelSelection).toMatchObject({ provider: "grok" });
      expect(thread?.session?.providerName).toBe("grok");
      expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.startSession.mock.calls).toHaveLength(1);
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.handoff.failed"),
      ).toMatchObject({
        payload: {
          reason: "background-tasks",
          detail: "Grok still has background tasks running in this thread.",
        },
      });
    });

    it("stops the source's background tasks when the user agrees to switch now", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      harness.hasLiveRuntimeTasks.mockReturnValue(Effect.succeed(true));

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-handoff-to-claude"),
          threadId,
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          providerHandoff: true,
          providerHandoffStopsBackgroundTasks: true,
        }),
      );

      // Clearing the source continuation stops its runtime and the tasks in it.
      await waitFor(() => harness.startSession.mock.calls.length === 2);
      expect(harness.clearSessionResumeCursor).toHaveBeenCalledWith({ threadId });
      await waitFor(async () =>
        Boolean(
          (await readHarnessThread(harness))?.activities.some(
            (activity) => activity.kind === "provider.handoff",
          ),
        ),
      );
      expect((await readHarnessThread(harness))?.modelSelection).toMatchObject({
        provider: "claudeAgent",
      });
    });

    it("rejects stopping background tasks outside a provider handoff", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);

      await expect(
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-stop-tasks-without-handoff"),
            threadId,
            modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
            providerHandoffStopsBackgroundTasks: true,
          }),
        ),
      ).rejects.toThrow(/only allowed as part of a provider handoff/);
      expect(harness.clearSessionResumeCursor).not.toHaveBeenCalled();
    });

    it("refuses a handoff while a turn is running", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
      });
      await runFirstGrokTurn(harness);
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-handoff-session-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "grok",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-handoff-live"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await expect(dispatchHandoff(harness)).rejects.toThrow(/still has a running turn/);
      const thread = await readHarnessThread(harness);
      expect(thread?.modelSelection).toMatchObject({ provider: "grok" });
      expect(harness.startSession.mock.calls).toHaveLength(1);
    });
  });

  it("rejects an explicit turn for a provider that is neither bound nor stored", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "grok", model: "grok-code-fast-1" },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-keepbound-1",
      messageId: "user-message-keepbound-1",
      text: "first turn on grok",
      createdAt: now,
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-keepbound-meta-update"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      }),
    );
    // The stored update waits for the next turn, which rebinds the session.
    await harness.drain();
    expect(harness.startSession.mock.calls.length).toBe(1);

    // An explicit turn naming the stored provider rebinds to it.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-keepbound-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-keepbound-2"),
          role: "user",
          text: "continue on claude",
          attachments: [],
        },
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    // A turn explicitly requesting the pre-rebind provider is now a foreign
    // request — neither bound nor stored — and must be rejected rather than
    // silently resurrecting grok.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-keepbound-3"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-keepbound-3"),
          role: "user",
          text: "back to grok",
          attachments: [],
        },
        modelSelection: { provider: "grok", model: "grok-code-fast-1" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = await readHarnessThread(harness);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });
    expect(harness.sendTurn.mock.calls.length).toBe(2);
    const thread = await readHarnessThread(harness);
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'grok'"),
      },
    });
  });

  it("keeps an idle session and finished turn unchanged during repeated permission changes", async () => {
    const harness = await createHarness({
      ingestRuntimeEvents: true,
      threadModelSelection: { provider: "codex", model: "gpt-6-luna" },
    });
    const now = new Date().toISOString();
    await dispatchHarnessUserTurn(harness, {
      messageId: "idle-permission-baseline",
      text: "first",
      createdAt: now,
    });
    await harness.drain();
    await harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: asEventId("idle-permission-turn-started"),
      provider: "codex",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      createdAt: now,
      payload: {},
      providerRefs: {},
    });
    await emitHarnessTurnTerminal(harness, {
      eventId: "idle-permission-turn-completed",
      provider: "codex",
      type: "completed",
    });
    await waitFor(
      async () => (await readHarnessThread(harness))?.latestTurn?.state === "completed",
    );
    await harness.drain();
    const before = await readHarnessThread(harness);
    const eventsBefore = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    for (const runtimeMode of ["auto", "full-access", "auto", "full-access"] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: ThreadId.makeUnsafe("thread-1"),
          runtimeMode,
          createdAt: now,
        }),
      );
      await harness.drain();
      const after = await readHarnessThread(harness);
      expect(after?.runtimeMode).toBe(runtimeMode);
      expect(after?.session).toEqual(before?.session);
      expect(after?.latestTurn).toEqual(before?.latestTurn);
      expect(after?.activities).toEqual(before?.activities);
      expect(harness.startSession).toHaveBeenCalledTimes(1);
    }
    const eventsAfter = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    expect(
      Array.from(eventsAfter)
        .slice(Array.from(eventsBefore).length)
        .map((event) => event.type),
    ).toEqual(Array(4).fill("thread.runtime-mode-set"));
  });

  it("defers idle runtime mode changes until the next turn and honors turn overrides", async () => {
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

    await waitFor(
      async () => (await readHarnessThread(harness))?.runtimeMode === "approval-required",
    );
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect((await readHarnessThread(harness))?.session?.runtimeMode).toBe("full-access");
    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-runtime-mode-2",
      messageId: "user-message-runtime-mode-2",
      text: "second",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-3"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-3"),
          role: "user",
          text: "third",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 3);
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);

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

    const thread = await readHarnessThread(harness);
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("restarts Codex sessions when the selected account options change", async () => {
    const harness = await createHarness({
      serverSettings: {
        providers: {
          codex: {
            homePath: "/tmp/shared-codex-home",
            accounts: [
              {
                id: "personal",
                label: "Personal",
                homePath: "/tmp/shared-codex-home",
                shadowHomePath: "/tmp/personal-codex-home",
              },
              {
                id: "work",
                label: "Work",
                homePath: "/tmp/shared-codex-home",
                shadowHomePath: "/tmp/work-codex-home",
              },
            ],
            selectedAccountId: "personal",
          },
        },
      },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-codex-account-1",
      messageId: "user-message-codex-account-1",
      text: "first account",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providers: { codex: { selectedAccountId: "work" } },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-codex-account-2",
      messageId: "user-message-codex-account-2",
      text: "second account",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerOptions: {
        codex: {
          accountId: "work",
          homePath: "/tmp/shared-codex-home",
          shadowHomePath: "/tmp/work-codex-home",
        },
      },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providers: { codex: { selectedAccountId: "default" } },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-codex-account-default",
      messageId: "user-message-codex-account-default",
      text: "default account",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 3);
    expect(harness.startSession.mock.calls[2]?.[1]).toMatchObject({
      providerOptions: {
        codex: {
          binaryPath: "codex",
          homePath: "/tmp/shared-codex-home",
        },
      },
    });
    expect(harness.startSession.mock.calls[2]?.[1]).not.toHaveProperty("resumeCursor");

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-codex-account-default-repeat",
      messageId: "user-message-codex-account-default-repeat",
      text: "still default account",
      createdAt: now,
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 4);
    expect(harness.startSession.mock.calls.length).toBe(3);
  });

  it("does not restart when provider options are structurally unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const providerOptions = {
      codex: {
        accountId: "personal",
        homePath: "/tmp/shared-codex-home",
        shadowHomePath: "/tmp/personal-codex-home",
      },
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-account-same-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-account-same-1"),
          role: "user",
          text: "first account",
          attachments: [],
        },
        providerOptions,
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
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-account-same-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-account-same-2"),
          role: "user",
          text: "same account",
          attachments: [],
        },
        providerOptions: {
          codex: {
            accountId: "personal",
            homePath: "/tmp/shared-codex-home",
            shadowHomePath: "/tmp/personal-codex-home",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
  });

  it("restarts Claude sessions when Claude provider options change", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
      serverSettings: {
        providers: {
          claudeAgent: {
            homePath: "/tmp/claude-personal",
          },
        },
      },
    });
    const now = new Date().toISOString();

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-claude-home-1",
      messageId: "user-message-claude-home-1",
      text: "personal claude",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.serverSettings.updateSettings({
        providers: { claudeAgent: { homePath: "/tmp/claude-work" } },
      }),
    );

    await dispatchHarnessUserTurn(harness, {
      commandId: "cmd-turn-start-claude-home-2",
      messageId: "user-message-claude-home-2",
      text: "work claude",
      createdAt: now,
    });

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      providerOptions: {
        claudeAgent: {
          homePath: "/tmp/claude-work",
        },
      },
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
  });
});
