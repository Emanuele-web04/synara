// FILE: ProviderCommandReactor.test.ts
// Purpose: Verifies provider intent orchestration, queueing, rollback, and transcript bootstrap flows.
// Layer: Orchestration integration tests
// Depends on: ProviderCommandReactorLive with in-memory provider and persistence services.

import { captureCrashResumeRecord } from "../quitResume.ts";
import { reconcileRestartStuckTurns } from "../startupTurnReconciliation.ts";
import * as providerUsageRecovery from "../../providerUsage/index.ts";
import { planRestartTurnReconciliation } from "../startupTurnReconciliation.ts";
import type { ModelSelection, OrchestrationCommand, ProviderRuntimeEvent } from "@synara/contracts";
import {
  CommandId,
  EventId,
  RuntimeItemId,
  ServerSettingsError,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Clock, Duration, Deferred, Effect, Exit, Option, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { PROVIDER_COMMAND_REACTOR_CONSUMER } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import {
  awaitInflightClaimSettlement,
  classifyProviderAttemptOutcome,
  hasBoundProviderSession,
  isSafeLegacyProviderBlocker,
  resolvePreTurnBaselineTimeoutMs,
} from "./ProviderCommandReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  asProjectId,
  asEventId,
  asTurnId,
  expiredCacheObservation,
  waitFor,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("legacy provider blocker recovery", () => {
  it("rejects a startup failure only when process cleanup was confirmed", () => {
    const outcome = classifyProviderAttemptOutcome(
      Exit.fail(
        new ProviderAdapterProcessError({
          provider: "codex",
          threadId: ThreadId.makeUnsafe("thread-start-failed"),
          reason: "startup-failed",
          detail: "Codex stdout closed during initialization.",
        }),
      ),
    );
    expect(outcome._tag).toBe("rejected");
  });

  it("keeps process lifecycle failures uncertain", () => {
    const outcome = classifyProviderAttemptOutcome(
      Exit.fail(
        new ProviderAdapterProcessError({
          provider: "claudeAgent",
          threadId: ThreadId.makeUnsafe("thread-exit-unproven"),
          detail: "Provider process tree did not prove exit (rootExited=false).",
        }),
      ),
    );

    expect(outcome._tag).toBe("uncertain");
  });

  it.each(["failure", "defect"] as const)(
    "keeps startup rejection uncertain when provider restoration adds a %s",
    async (kind) => {
      const startupError = new ProviderAdapterProcessError({
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-switch-start-failed"),
        reason: "startup-failed",
        detail: "Codex startup failed after confirmed cleanup.",
      });
      const restorationError = new ProviderAdapterProcessError({
        provider: "claudeAgent",
        threadId: startupError.threadId,
        detail: "Previous provider restoration did not prove process-tree exit.",
      });
      const exit = await Effect.runPromise(
        Effect.fail(startupError).pipe(
          Effect.onExit(() =>
            kind === "failure" ? Effect.fail(restorationError) : Effect.die(restorationError),
          ),
          Effect.exit,
        ),
      );

      expect(classifyProviderAttemptOutcome(exit)).toMatchObject({
        _tag: "uncertain",
        detail: expect.stringContaining(restorationError.detail),
      });
    },
  );

  it("accepts only failures that prove the command frame was not written", () => {
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree 66212 did not prove exit (rootExited=true, captureComplete=false; no captured descendants remain).",
      ),
    ).toBe(false);
    expect(
      isSafeLegacyProviderBlocker("Codex app-server stdin closed before the frame was written."),
    ).toBe(true);
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree did not prove exit (rootExited=false, captureComplete=true).",
      ),
    ).toBe(false);
    expect(
      isSafeLegacyProviderBlocker(
        "Provider process tree did not prove exit (rootExited=true, captureComplete=false; captured descendants remain).",
      ),
    ).toBe(false);
    expect(isSafeLegacyProviderBlocker("Provider process tree did not prove exit.")).toBe(false);
    expect(isSafeLegacyProviderBlocker("Session stopped before request completed.")).toBe(false);
    expect(isSafeLegacyProviderBlocker("The provider rejected the prompt.")).toBe(false);
  });
});

describe("hasBoundProviderSession", () => {
  it.each([
    [null, false],
    ["stopped", false],
    ["error", false],
    ["starting", true],
    ["running", true],
    ["idle", true],
    ["ready", true],
    ["interrupted", true],
  ] as const)("treats %s status as bound=%s", (status, expected) => {
    expect(hasBoundProviderSession(status === null ? null : { status })).toBe(expected);
  });
});

describe("ProviderCommandReactor", () => {
  it.each([
    [undefined, 5000],
    ["abc", 5000],
    ["0", 5000],
    ["1", 1000],
    ["15000", 15000],
    ["90000", 30000],
  ] as const)("bounds the operator baseline budget %s to %s ms", (raw, expected) => {
    expect(
      resolvePreTurnBaselineTimeoutMs(
        raw === undefined ? {} : { SYNARA_PRE_TURN_BASELINE_TIMEOUT_MS: raw },
      ),
    ).toBe(expected);
  });
  let scope: Scope.Closeable | null = null;
  const { createHarness, readHarnessThread, dispatchHarnessUserTurn } =
    useProviderCommandReactorHarness({
      setScope: (next) => {
        scope = next;
      },
    });

  describe("usage-limit continuation delivery", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const limitedTurnId = asTurnId("usage-limit-failed-turn");
    const bindingKey = "mock-provider-account-binding";

    const mockBindingKey = () =>
      vi
        .spyOn(providerUsageRecovery, "providerUsageRecoveryBindingKey")
        .mockImplementation(() => Effect.succeed(bindingKey));

    const stopThread = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      commandId: string,
      scope: { readonly turnId?: TurnId; readonly usageLimitRecoveryId?: string } = {},
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(commandId),
          threadId,
          ...scope,
          requestedBy: "user",
          createdAt: new Date().toISOString(),
        }),
      );

    // Holds the next provider send until the returned release resolves it with its accepted turn.
    const gateNextSend = (harness: Awaited<ReturnType<typeof createHarness>>) => {
      let release!: (value: { threadId: ThreadId; turnId: TurnId }) => void;
      const gate = new Promise<{ threadId: ThreadId; turnId: TurnId }>((resolve) => {
        release = resolve;
      });
      harness.sendTurn.mockImplementationOnce(() => Effect.promise(() => gate));
      return release;
    };

    // A native turn starts, waits for the reactor to observe it, then ends on a usage limit.
    const emitNativeStartThenUsageLimit = async (
      harness: Awaited<ReturnType<typeof createHarness>>,
      turnId: TurnId,
      ids: { readonly started: string; readonly terminal: string },
      options: {
        readonly startedWhen: () => Promise<boolean>;
        readonly errorMessage?: string;
        readonly resetAt?: string;
      },
    ) => {
      const base = {
        provider: "codex" as const,
        providerInstanceId: "codex",
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
        providerRefs: {},
      };
      await harness.emitRuntimeEvent({
        ...base,
        type: "turn.started",
        eventId: asEventId(ids.started),
        payload: {},
      });
      await waitFor(options.startedWhen);
      harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      await harness.emitRuntimeEvent({
        ...base,
        type: "turn.completed",
        eventId: asEventId(ids.terminal),
        payload: {
          state: "failed",
          errorMessage: options.errorMessage ?? "Usage limit reached",
          usageLimit: { resetAt: options.resetAt ?? new Date(Date.now() + 60_000).toISOString() },
        },
      });
    };

    async function seedLimitSource(
      harness: Awaited<ReturnType<typeof createHarness>>,
      queuedText?: string,
    ) {
      const createdAt = new Date(Date.now() - 3_000).toISOString();
      const selection = (await readHarnessThread(harness))!.modelSelection;
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: limitedTurnId,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("usage-limit-running-source"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: selection.provider,
            providerInstanceId: selection.instanceId ?? selection.provider,
            runtimeMode: "approval-required",
            activeTurnId: limitedTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      if (queuedText) {
        await dispatchHarnessUserTurn(harness, {
          messageId: "usage-limit-accepted-queue",
          text: queuedText,
          createdAt,
        });
        await harness.drain();
      }
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.usage-limit.source",
          commandId: CommandId.makeUnsafe("usage-limit-freeze-source"),
          threadId,
          source: { turnId: limitedTurnId, bindingKey, policyEpoch: 0 },
          createdAt,
        }),
      );
      expect((await readHarnessThread(harness))?.usageLimitRecoverySource).toMatchObject({
        turnId: limitedTurnId,
        bindingKey,
        policyEpoch: 0,
      });
      return createdAt;
    }

    async function seedLimitWait(
      harness: Awaited<ReturnType<typeof createHarness>>,
      queuedText?: string,
    ) {
      const createdAt = await seedLimitSource(harness, queuedText);
      const selection = (await readHarnessThread(harness))!.modelSelection;
      harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("usage-limit-failed-source"),
          threadId,
          session: {
            threadId,
            status: "error",
            providerName: selection.provider,
            providerInstanceId: selection.instanceId ?? selection.provider,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: "Usage limit reached",
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      const sourceBeforeSchedule = await readHarnessThread(harness);
      expect(sourceBeforeSchedule?.latestTurn).toMatchObject({
        turnId: limitedTurnId,
        state: "error",
      });
      expect(sourceBeforeSchedule?.usageLimitRecoveryCancelledTurnId).not.toBe(limitedTurnId);
      const wait = {
        id: "usage-limit-delivery-episode",
        turnId: limitedTurnId,
        resetAt: new Date(Date.now() - 1_000).toISOString(),
        autoResume: true as const,
        provider: selection.provider,
        providerInstanceId: selection.instanceId ?? selection.provider,
        model: selection.model,
        bindingKey,
        policyEpoch: 0,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.usage-limit.schedule",
          commandId: CommandId.makeUnsafe("usage-limit-arm"),
          threadId,
          recovery: wait,
          createdAt,
        }),
      );
      await waitFor(
        async () => (await readHarnessThread(harness))?.usageLimitRecovery?.id === wait.id,
      );
      return wait;
    }

    const requestResume = (
      harness: Awaited<ReturnType<typeof createHarness>>,
      recoveryId: string,
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.usage-limit.resume",
          commandId: CommandId.makeUnsafe(`usage-limit-resume-${crypto.randomUUID()}`),
          threadId,
          recoveryId,
          policyEpoch: 0,
          createdAt: new Date().toISOString(),
        }),
      );

    async function seedCompletedHumanTurn(harness: Awaited<ReturnType<typeof createHarness>>) {
      const previousTurnId = asTurnId("human-previous-completed-turn");
      const createdAt = new Date(Date.now() - 2_000).toISOString();
      for (const status of ["running", "ready"] as const) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`human-previous-${status}`),
            threadId,
            session: {
              threadId,
              status,
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "approval-required",
              activeTurnId: status === "running" ? previousTurnId : null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
      }
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "ready",
        runtimeMode: "approval-required",
      });
      await harness.drain();
      expect((await readHarnessThread(harness))?.latestTurn).toMatchObject({
        turnId: previousTurnId,
        state: "completed",
      });
      return previousTurnId;
    }

    it.each([
      { previousTurn: false, cancellation: "Stop" },
      { previousTurn: true, cancellation: "Stop" },
      { previousTurn: true, cancellation: "setting disabled and re-enabled" },
    ])(
      "a human send refused before its ACK cannot arm after $cancellation (previousTurn=$previousTurn)",
      async ({ previousTurn, cancellation }) => {
        const identity = mockBindingKey();
        const harness = await createHarness({
          ingestRuntimeEvents: true,
          serverSettings: { autoResumeAfterUsageLimits: true },
        });
        const previousTurnId = previousTurn ? await seedCompletedHumanTurn(harness) : undefined;
        const releaseSend = gateNextSend(harness);
        await dispatchHarnessUserTurn(harness, {
          messageId: "human-stopped-awaiting-ack",
          text: "Perform the requested work",
          createdAt: new Date().toISOString(),
        });
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        const starting = await readHarnessThread(harness);
        expect(starting?.session?.activeTurnId).toBeNull();
        expect(starting?.latestTurn?.turnId).toBe(previousTurnId);
        expect(starting?.usageLimitRecoverySource).toMatchObject({
          bindingKey: "admission",
          admissionSequence: expect.any(Number),
        });
        if (cancellation === "Stop") {
          await stopThread(harness, "human-stop-before-ack");
        } else {
          await Effect.runPromise(
            harness.serverSettings.updateSettings({ autoResumeAfterUsageLimits: false }),
          );
          await Effect.runPromise(
            harness.serverSettings.updateSettings({ autoResumeAfterUsageLimits: true }),
          );
        }
        const actual = asTurnId("human-late-start-before-ack");
        harness.setRuntimeSessionTurnState({
          threadId,
          status: "running",
          runtimeMode: "approval-required",
          activeTurnId: actual,
        });
        await emitNativeStartThenUsageLimit(
          harness,
          actual,
          { started: "human-late-started", terminal: "human-late-refused" },
          {
            startedWhen: async () =>
              (await readHarnessThread(harness))?.latestTurn?.turnId === actual,
          },
        );
        await waitFor(
          async () => (await readHarnessThread(harness))?.latestTurn?.state === "error",
        );
        expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
        expect(identity).not.toHaveBeenCalled();
        releaseSend({ threadId, turnId: actual });
        await harness.drain();
        if (cancellation === "Stop") {
          expect((await readHarnessThread(harness))?.usageLimitRecoveryCancelledTurnId).toBe(
            actual,
          );
        }
        expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      },
    );

    it("stops the actual human turn accepted after an untargeted Stop", async () => {
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      await seedCompletedHumanTurn(harness);
      const releaseSend = gateNextSend(harness);
      await dispatchHarnessUserTurn(harness, {
        messageId: "human-stop-late-accepted",
        text: "Perform the requested work",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await stopThread(harness, "human-stop-before-accept");
      const actual = asTurnId("human-accepted-after-stop");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: actual,
      });
      releaseSend({ threadId, turnId: actual });
      await waitFor(
        async () =>
          (await readHarnessThread(harness))?.usageLimitRecoveryCancelledTurnId === actual,
      );
      await harness.drain();
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({ threadId, turnId: actual });
      expect((await readHarnessThread(harness))?.usageLimitRecoveryCancelledTurnId).toBe(actual);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("a Stop after the human intent but before admission interrupts its late accepted native turn", async () => {
      mockBindingKey();
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      await seedCompletedHumanTurn(harness);
      const dispatch = harness.engine.dispatch;
      let stopSequence: number | undefined;
      let executingSequence: number | undefined;
      harness.interceptEngineDispatch((command) => {
        if (command.type !== "thread.usage-limit.admit" || stopSequence !== undefined)
          return undefined;
        executingSequence = command.admissionSequence;
        return Effect.gen(function* () {
          const stopped = yield* dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("human-stop-before-source-admit"),
            threadId,
            requestedBy: "user",
            createdAt: new Date().toISOString(),
          });
          stopSequence = stopped.sequence;
          // The Stop is durable before the later source-admission event.
          return yield* dispatch(command);
        });
      });
      const releaseSend = gateNextSend(harness);
      await dispatchHarnessUserTurn(harness, {
        messageId: "human-stop-before-admission",
        text: "Perform the requested work",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(stopSequence).toBeGreaterThan(executingSequence!);
      expect((await readHarnessThread(harness))?.usageLimitRecoverySource?.admissionSequence).toBe(
        executingSequence,
      );
      const actual = asTurnId("human-late-accepted-after-pre-admission-stop");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: actual,
      });
      releaseSend({ threadId, turnId: actual });
      const acceptedControlId = "command:cmd-human-stop-before-admission";
      await waitFor(() =>
        harness.interruptTurn.mock.calls.some(
          ([input]) => input.controlRequestId === acceptedControlId,
        ),
      );
      await harness.drain();
      expect(
        harness.interruptTurn.mock.calls.find(
          ([input]) => input.controlRequestId === acceptedControlId,
        )?.[0],
      ).toMatchObject({ threadId, turnId: actual });
      await emitNativeStartThenUsageLimit(
        harness,
        actual,
        {
          started: "pre-admit-stop-late-native-start",
          terminal: "pre-admit-stop-late-native-limit",
        },
        {
          startedWhen: async () =>
            (await readHarnessThread(harness))?.latestTurn?.turnId === actual,
        },
      );
      await waitFor(async () => (await readHarnessThread(harness))?.latestTurn?.state === "error");
      expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("ignores an old targeted Stop while a newer human send awaits its ACK", async () => {
      mockBindingKey();
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      const previousTurnId = await seedCompletedHumanTurn(harness);
      const releaseSend = gateNextSend(harness);
      await dispatchHarnessUserTurn(harness, {
        messageId: "human-stale-target",
        text: "Perform the new request",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await stopThread(harness, "human-old-target-stop", { turnId: previousTurnId });
      const actual = asTurnId("human-new-turn-after-stale-stop");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: actual,
      });
      releaseSend({ threadId, turnId: actual });
      await harness.drain();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      await emitNativeStartThenUsageLimit(
        harness,
        actual,
        { started: "human-new-turn-started", terminal: "human-new-turn-refused" },
        {
          startedWhen: async () =>
            (await readHarnessThread(harness))?.usageLimitRecoverySource?.bindingKey === bindingKey,
        },
      );
      await waitFor(async () => (await readHarnessThread(harness))?.usageLimitRecovery != null);
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toMatchObject({
        turnId: actual,
      });
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("manually resumes a quota-paused goal after clearing its wait", async () => {
      mockBindingKey();
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("quota-goal-deferred"),
          threadId,
          goal: "Finish the complete requested objective",
          goalStartBehavior: "defer",
        }),
      );
      await seedLimitWait(harness);
      expect((await readHarnessThread(harness))?.goalPausedAt).not.toBeNull();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("quota-goal-manual-resume"),
          threadId,
          goalPaused: false,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.goalPausedAt).toBeNull();
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain(
        "Continue working toward the active thread goal",
      );
      expect((await readHarnessThread(harness))?.usageLimitRecoverySource).toMatchObject({
        bindingKey: "admission",
        admissionSequence: expect.any(Number),
      });
      const actual = asTurnId("turn-1");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: actual,
      });
      await emitNativeStartThenUsageLimit(
        harness,
        actual,
        {
          started: "manual-goal-resume-native-started",
          terminal: "manual-goal-resume-native-refused",
        },
        {
          startedWhen: async () =>
            (await readHarnessThread(harness))?.usageLimitRecoverySource?.bindingKey === bindingKey,
          errorMessage: "Usage limit reached again",
        },
      );
      await waitFor(
        async () => (await readHarnessThread(harness))?.usageLimitRecovery?.turnId === actual,
      );
      expect((await readHarnessThread(harness))?.goalPausedAt).not.toBeNull();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("sends one guarded continuation and records its actual accepted turn", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe(
        "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off. " +
          "Check the conversation and current workspace state, verify whether pending operations already completed before repeating them, and preserve pending approvals and user decisions.",
      );
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toMatchObject({
        id: wait.id,
        state: "resuming",
        resumedTurnId: "turn-1",
      });
      await requestResume(harness, wait.id);
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("releases accepted queued work before creating a continuation prompt", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness, "Accepted queued work has priority");
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("Accepted queued work has priority");
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
    });

    it("a cancelled wait interrupts only the continuation turn accepted after cancellation", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      const releaseSend = gateNextSend(harness);
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await stopThread(harness, "usage-limit-stop-awaiting-send", {
        usageLimitRecoveryId: wait.id,
      });
      const acceptedTurnId = asTurnId("usage-limit-accepted-after-stop");
      harness.setRuntimeSessionTurnState({
        threadId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: acceptedTurnId,
      });
      releaseSend({ threadId, turnId: acceptedTurnId });
      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        turnId: acceptedTurnId,
      });
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.usageLimitRecoveryCancelledTurnId).toBe(
        acceptedTurnId,
      );
    });

    it.each(["scoped Stop", "setting OFF/ON"] as const)(
      "%s before quota send admission prevents startup and source resurrection",
      async (cancellation) => {
        mockBindingKey();
        const harness = await createHarness({
          serverSettings: { autoResumeAfterUsageLimits: true },
        });
        const wait = await seedLimitWait(harness);
        const dispatch = harness.engine.dispatch;
        let cancelled = false;
        harness.interceptEngineDispatch((command) => {
          if (
            command.type !== "thread.usage-limit.admit" ||
            command.recoveryId !== wait.id ||
            cancelled
          )
            return undefined;
          cancelled = true;
          return Effect.gen(function* () {
            if (cancellation === "scoped Stop") {
              yield* dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.makeUnsafe("scoped-stop-before-admit"),
                threadId,
                usageLimitRecoveryId: wait.id,
                requestedBy: "user",
                createdAt: new Date().toISOString(),
              });
            } else {
              yield* harness.serverSettings
                .updateSettings({ autoResumeAfterUsageLimits: false })
                .pipe(Effect.orDie);
              yield* harness.serverSettings
                .updateSettings({ autoResumeAfterUsageLimits: true })
                .pipe(Effect.orDie);
            }
            return yield* dispatch(command);
          });
        });
        await requestResume(harness, wait.id);
        await waitFor(() => cancelled);
        await harness.drain();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
        expect((await readHarnessThread(harness))?.usageLimitRecoverySource ?? null).toBeNull();
        expect((await readHarnessThread(harness))?.session?.status).not.toBe("starting");
      },
    );

    it.each(["before native start", "before source commit"] as const)(
      "a scoped Stop %s prevents a continuation refusal before ACK from rearming",
      async (cancelAt) => {
        mockBindingKey();
        const harness = await createHarness({
          ingestRuntimeEvents: true,
          serverSettings: { autoResumeAfterUsageLimits: true },
        });
        const wait = await seedLimitWait(harness);
        const releaseSend = gateNextSend(harness);
        await requestResume(harness, wait.id);
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        const stop = {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("scoped-stop-before-native-ack"),
          threadId,
          usageLimitRecoveryId: wait.id,
          requestedBy: "user",
          createdAt: new Date().toISOString(),
        } satisfies OrchestrationCommand;
        if (cancelAt === "before native start") {
          await Effect.runPromise(harness.engine.dispatch(stop));
        } else {
          const dispatch = harness.engine.dispatch;
          let cancelled = false;
          harness.interceptEngineDispatch((command) => {
            if (
              command.type !== "thread.usage-limit.source" ||
              command.source.bindingKey !== "pending" ||
              cancelled
            )
              return undefined;
            cancelled = true;
            return Effect.gen(function* () {
              yield* dispatch(stop);
              return yield* dispatch(command);
            });
          });
        }
        const actual = asTurnId("scoped-stopped-refusal-before-ack");
        try {
          harness.setRuntimeSessionTurnState({
            threadId,
            status: "running",
            runtimeMode: "approval-required",
            activeTurnId: actual,
          });
          await emitNativeStartThenUsageLimit(
            harness,
            actual,
            { started: "scoped-late-start", terminal: "scoped-late-limit" },
            {
              startedWhen: async () =>
                (await readHarnessThread(harness))?.latestTurn?.turnId === actual,
            },
          );
          await waitFor(
            async () => (await readHarnessThread(harness))?.latestTurn?.state === "error",
          );
          expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
        } finally {
          releaseSend({ threadId, turnId: actual });
        }
        await harness.drain();
        expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      },
    );

    it("interrupts a native turn when Stop wins admission of its accepted-turn marker", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      const actual = asTurnId("usage-limit-acceptance-marker-race");
      harness.sendTurn.mockImplementationOnce(() => {
        harness.setRuntimeSessionTurnState({
          threadId,
          status: "running",
          runtimeMode: "approval-required",
          activeTurnId: actual,
        });
        return Effect.succeed({ threadId, turnId: actual });
      });
      const dispatch = harness.engine.dispatch;
      let stopped = false;
      harness.interceptEngineDispatch((command) => {
        if (command.type !== "thread.usage-limit.started" || stopped) return undefined;
        stopped = true;
        return Effect.gen(function* () {
          yield* dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("stop-before-accepted-marker"),
            threadId,
            usageLimitRecoveryId: wait.id,
            requestedBy: "user",
            createdAt: new Date().toISOString(),
          });
          return yield* dispatch(command);
        });
      });
      await requestResume(harness, wait.id);
      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({ threadId, turnId: actual });
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.usageLimitRecoveryCancelledTurnId).toBe(actual);
    });

    it.each(["disabled setting", "changed provider binding", "unknown provider binding"] as const)(
      "%s cancels before provider execution",
      async (reason) => {
        const identity = mockBindingKey();
        const harness = await createHarness({
          serverSettings: { autoResumeAfterUsageLimits: true },
        });
        const wait = await seedLimitWait(harness);
        if (reason === "disabled setting")
          await Effect.runPromise(
            harness.serverSettings.updateSettings({ autoResumeAfterUsageLimits: false }),
          );
        else
          identity.mockImplementation(() =>
            Effect.succeed(
              reason === "unknown provider binding" ? null : "replacement-provider-account",
            ),
          );
        await requestResume(harness, wait.id);
        await waitFor(async () => (await readHarnessThread(harness))?.usageLimitRecovery == null);
        await harness.drain();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it.each([false, true])(
      "a bounded account read timeout preserves the verified episode unless Stop won (cancel=%s)",
      async (cancelWhileReading) => {
        const identity = vi
          .spyOn(providerUsageRecovery, "providerUsageRecoveryBindingKey")
          .mockImplementationOnce(() => Effect.never)
          .mockImplementation(() => Effect.succeed(bindingKey));
        const harness = await createHarness({
          serverSettings: { autoResumeAfterUsageLimits: true },
          usageLimitBindingReadTimeout: Duration.millis(150),
        });
        const wait = await seedLimitWait(harness);
        await requestResume(harness, wait.id);
        await waitFor(() => identity.mock.calls.length === 1);
        expect((await readHarnessThread(harness))?.usageLimitRecovery).toMatchObject({
          id: wait.id,
          state: "resuming",
        });
        if (cancelWhileReading)
          await stopThread(harness, "stop-during-binding-timeout", {
            usageLimitRecoveryId: wait.id,
          });
        await harness.drain();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        const afterRead = await readHarnessThread(harness);
        if (cancelWhileReading) {
          expect(afterRead?.usageLimitRecovery ?? null).toBeNull();
          expect(afterRead?.usageLimitRecoverySource ?? null).toBeNull();
          return;
        }
        expect(afterRead?.usageLimitRecovery).toMatchObject({
          id: wait.id,
          state: "waiting",
          bindingKey,
        });
        expect(afterRead?.usageLimitRecovery?.resumedTurnId).toBeUndefined();
        expect(afterRead?.usageLimitRecoverySource?.bindingKey).toBe(bindingKey);
        await requestResume(harness, wait.id);
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await harness.drain();
        expect(identity).toHaveBeenCalledTimes(2);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect((await readHarnessThread(harness))?.usageLimitRecovery).toMatchObject({
          id: wait.id,
          state: "resuming",
          resumedTurnId: "turn-1",
        });
      },
    );

    it("defers a surfaced account-read failure without losing the verified binding", async () => {
      vi.spyOn(providerUsageRecovery, "providerUsageRecoveryBindingKey").mockImplementationOnce(
        () =>
          Effect.fail(
            new ServerSettingsError({
              settingsPath: "test-settings.json",
              detail: "The settings read is temporarily unavailable.",
            }),
          ),
      );
      const harness = await createHarness({
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await waitFor(
        async () => (await readHarnessThread(harness))?.usageLimitRecovery?.state === "waiting",
      );
      await harness.drain();
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toMatchObject({
        id: wait.id,
        state: "waiting",
        bindingKey,
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(
        await Effect.runPromise(harness.reactor.listBlockingDeliveries({ threadId, limit: 1 })),
      ).toEqual([]);
    });

    it("resumes an ordinary task without asking when the Claude context is cold", async () => {
      mockBindingKey();
      const getClaudeCacheObservation = vi.fn(() => Effect.sync(expiredCacheObservation));
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await harness.drain();
      expect(getClaudeCacheObservation).not.toHaveBeenCalled();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const resumed = await readHarnessThread(harness);
      expect(resumed?.claudeCacheReview ?? null).toBeNull();
      expect(resumed?.goal?.trim() ?? "").toBe("");
      expect(resumed?.usageLimitRecovery).toMatchObject({
        id: wait.id,
        state: "resuming",
        resumedTurnId: "turn-1",
      });
    });

    it("clears Resuming when provider startup is definitively rejected", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      await Effect.runPromise(harness.stopRuntimeSession({ threadId }));
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: "codex",
            operation: "startSession",
            issue: "Mock startup rejected before provider acceptance.",
          }),
        ),
      );
      await requestResume(harness, wait.id);
      await waitFor(async () => (await readHarnessThread(harness))?.usageLimitRecovery == null);
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.session?.status).toBe("error");
    });

    it("settles a hanging ordinary-task continuation as uncertain without retaining Resuming", async () => {
      vi.spyOn(providerUsageRecovery, "providerUsageRecoveryBindingKey").mockImplementation(() =>
        Effect.sleep("40 millis").pipe(Effect.as(bindingKey)),
      );
      const deadline = Effect.runSync(Deferred.make<void>());
      const liveClock = Effect.runSync(Effect.service(Clock.Clock));
      const commandClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => liveClock.currentTimeMillisUnsafe(),
        currentTimeMillis: liveClock.currentTimeMillis,
        currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
        currentTimeNanos: liveClock.currentTimeNanos,
        // Establish the provider hang before expiring the actual delivery budget.
        sleep: (duration) =>
          Duration.toMillis(duration) === 25 ? Deferred.await(deadline) : liveClock.sleep(duration),
      };
      const harness = await createHarness({
        serverSettings: { autoResumeAfterUsageLimits: true },
        commandEventTimeout: Duration.millis(25),
        startReactor: false,
      });
      if (!scope) throw new Error("Missing reactor scope");
      await Effect.runPromise(
        harness.reactor.start.pipe(
          Effect.provideService(Clock.Clock, commandClock),
          Scope.provide(scope),
        ),
      );
      const wait = await seedLimitWait(harness);
      harness.sendTurn.mockImplementationOnce(() => Effect.never);
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await Effect.runPromise(Deferred.succeed(deadline, undefined));
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
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(
        Option.getOrThrow(
          await Effect.runPromise(
            harness.deliveryRepository.firstBlockingDeliveryForThread({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              threadId,
            }),
          ),
        ).state,
      ).toBe("uncertain");
    });

    it("reconciles an accepted recovery even when the native turn.started notification never arrived", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const persisted = await readHarnessThread(harness);
      if (!persisted) throw new Error("Missing accepted recovery");
      expect(persisted.session?.status).toBe("starting");
      expect(persisted.latestTurn?.turnId).toBe(limitedTurnId);
      expect(persisted.usageLimitRecovery).toMatchObject({
        state: "resuming",
        resumedTurnId: "turn-1",
      });
      const commands = planRestartTurnReconciliation({
        threads: [persisted],
        now: new Date(Date.now() + 1_000).toISOString(),
      });
      expect(commands.some((command) => command.type === "thread.session.set")).toBe(true);
      for (const command of commands) await Effect.runPromise(harness.engine.dispatch(command));
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.session?.status).toBe("interrupted");
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("preserves a due but unclaimed recovery intent for its first safe delivery after restart", async () => {
      mockBindingKey();
      const harness = await createHarness({
        startReactor: false,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      const persisted = await readHarnessThread(harness);
      if (!persisted) throw new Error("Missing unclaimed recovery");
      expect(
        planRestartTurnReconciliation({ threads: [persisted], now: new Date().toISOString() }),
      ).toEqual([]);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("clears an accepted recovery when boot reconciles its persisted orphan turn", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const accepted = await readHarnessThread(harness);
      const resumedTurnId = accepted?.usageLimitRecovery?.resumedTurnId;
      if (!accepted?.session || !resumedTurnId)
        throw new Error("Expected accepted recovery ownership");
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("usage-limit-native-start-before-crash"),
          threadId,
          session: {
            ...accepted.session,
            status: "running",
            activeTurnId: resumedTurnId,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      const persisted = await readHarnessThread(harness);
      if (!persisted) throw new Error("Missing persisted recovery");
      expect(persisted.usageLimitRecovery).toMatchObject({ state: "resuming", resumedTurnId });
      const cleanup = planRestartTurnReconciliation({
        threads: [persisted],
        now: new Date(Date.now() + 1_000).toISOString(),
      });
      for (const command of cleanup) await Effect.runPromise(harness.engine.dispatch(command));
      const reconciled = await readHarnessThread(harness);
      expect(reconciled?.session?.status).toBe("interrupted");
      expect(reconciled?.usageLimitRecovery).toBeNull();
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("never replays an uncertain continuation delivery after reactor restart", async () => {
      mockBindingKey();
      const harness = await createHarness({ serverSettings: { autoResumeAfterUsageLimits: true } });
      const wait = await seedLimitWait(harness);
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "Connection closed after the provider may have accepted the prompt.",
          }),
        ),
      );
      await requestResume(harness, wait.id);
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
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const blocker = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId,
          }),
        ),
      );
      expect(blocker.state).toBe("uncertain");
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
    });

    it("settles a resumed native refusal without replaying its prompt or rearming the same reset", async () => {
      mockBindingKey();
      const harness = await createHarness({
        ingestRuntimeEvents: true,
        serverSettings: { autoResumeAfterUsageLimits: true },
      });
      const wait = await seedLimitWait(harness);
      await requestResume(harness, wait.id);
      await waitFor(
        async () =>
          (await readHarnessThread(harness))?.usageLimitRecovery?.resumedTurnId === "turn-1",
      );
      const resumedTurnId = asTurnId("turn-1");
      await emitNativeStartThenUsageLimit(
        harness,
        resumedTurnId,
        { started: "usage-limit-resumed-started", terminal: "usage-limit-resumed-refused" },
        {
          startedWhen: async () =>
            (await readHarnessThread(harness))?.usageLimitRecoverySource?.turnId === resumedTurnId,
          errorMessage: "Still limited at the same advertised reset",
          resetAt: wait.resetAt,
        },
      );
      await waitFor(async () => (await readHarnessThread(harness))?.usageLimitRecovery == null);
      const fresh = await harness.restartReactor();
      await fresh.start();
      await Effect.runPromise(fresh.reactor.drain);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect((await readHarnessThread(harness))?.usageLimitRecovery).toBeNull();
      expect((await readHarnessThread(harness))?.latestTurn?.state).toBe("error");
    });

    it.each([
      { pendingIdentity: false, outcome: "armed" },
      { pendingIdentity: true, outcome: "armed" },
      { pendingIdentity: true, outcome: "disabled" },
      { pendingIdentity: true, outcome: "unknown account" },
    ])(
      "holds raw quota drain until canonical terminal commit (pendingIdentity=$pendingIdentity, outcome=$outcome)",
      async ({ pendingIdentity, outcome }) => {
        vi.spyOn(providerUsageRecovery, "providerUsageRecoveryBindingKey").mockImplementation(() =>
          Effect.succeed(outcome === "unknown account" ? null : bindingKey),
        );
        const harness = await createHarness({
          ingestRuntimeEvents: true,
          serverSettings: { autoResumeAfterUsageLimits: true },
        });
        await seedLimitSource(harness, "Do not send before reset");
        if (pendingIdentity) {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.usage-limit.admit",
              commandId: CommandId.makeUnsafe("raw-limit-pending-admission"),
              threadId,
              admissionSequence: (await Effect.runPromise(harness.engine.getReadModel()))
                .snapshotSequence,
              policyEpoch: 0,
              createdAt: new Date().toISOString(),
            }),
          );
        }
        let releaseSchedule!: () => void;
        let scheduleEntered = false;
        const scheduleGate = new Promise<void>((resolve) => {
          releaseSchedule = resolve;
        });
        harness.interceptEngineDispatch((command) => {
          const isHeld = pendingIdentity
            ? command.type === "thread.usage-limit.source" &&
              command.source.bindingKey === "pending"
            : command.type === "thread.session.set" && command.usageLimitRecovery !== undefined;
          if (!isHeld || scheduleEntered) return undefined;
          scheduleEntered = true;
          return Effect.promise(() => scheduleGate).pipe(
            Effect.flatMap(() => harness.engine.dispatch(command)),
          );
        });
        if (pendingIdentity) {
          await harness.emitRuntimeEvent({
            type: "turn.started",
            eventId: asEventId("raw-limit-pending-start"),
            provider: "codex",
            providerInstanceId: "codex",
            threadId,
            turnId: limitedTurnId,
            createdAt: new Date().toISOString(),
            providerRefs: {},
            payload: {},
          });
          await waitFor(() => scheduleEntered);
          expect((await readHarnessThread(harness))?.usageLimitRecoverySource?.bindingKey).toBe(
            "admission",
          );
        }
        if (outcome === "disabled") {
          await Effect.runPromise(
            harness.serverSettings.updateSettings({ autoResumeAfterUsageLimits: false }),
          );
        }
        harness.setRuntimeSessionTurnState({ threadId, status: "ready" });
        const terminal = {
          type: "turn.completed",
          eventId: asEventId("usage-limit-raw-terminal"),
          provider: "codex",
          providerInstanceId: "codex",
          threadId,
          turnId: limitedTurnId,
          createdAt: new Date().toISOString(),
          providerRefs: {},
          payload: {
            state: "failed",
            errorMessage: "Usage limit reached",
            usageLimit: { resetAt: new Date(Date.now() + 60_000).toISOString() },
          },
        } satisfies ProviderRuntimeEvent;
        await harness.emitRuntimeEvent(terminal);
        await waitFor(() => scheduleEntered);
        await harness.drain();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        const queued = await Effect.runPromise(
          harness.queuedTurnPromotionRepository.listPendingThreadIds,
        );
        expect(queued).toContain(threadId);
        releaseSchedule();
        if (outcome === "armed") {
          await waitFor(async () => (await readHarnessThread(harness))?.usageLimitRecovery != null);
          // A delayed/repeated raw notification can also arrive after the same
          // canonical terminal and wait have already committed.
          await harness.emitRuntimeEvent(terminal);
          await harness.drain();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect(
            await Effect.runPromise(harness.queuedTurnPromotionRepository.listPendingThreadIds),
          ).toContain(threadId);
        } else {
          await waitFor(() => harness.sendTurn.mock.calls.length === 1);
          await harness.drain();
          expect((await readHarnessThread(harness))?.usageLimitRecovery ?? null).toBeNull();
          expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("Do not send before reset");
        }
      },
    );
  });

  it("includes passive completion context only on a human send and preserves the visible user message", async () => {
    const harness = await createHarness();
    await harness.seedCompletion();
    const beforeCompletion = await readHarnessThread(harness);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("passive-result"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requireUnarchived: true,
        activity: {
          id: EventId.makeUnsafe("passive-result"),
          kind: "synara.task.completed",
          tone: "info",
          summary: "Delegated task completed",
          payload: { detail: "delegated result" },
          turnId: null,
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();
    const afterCompletion = await readHarnessThread(harness);
    expect(afterCompletion?.latestHumanMessageAt).toBe(beforeCompletion?.latestHumanMessageAt);
    expect(afterCompletion?.session).toEqual(beforeCompletion?.session);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await dispatchHarnessUserTurn(harness, {
      messageId: "completion-human-message",
      text: "What happened?",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("delegated result");
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("untrusted child output");
    expect(
      (await readHarnessThread(harness))?.messages.find(
        (message) => message.id === "completion-human-message",
      )?.text,
    ).toBe("What happened?");
    expect((await harness.completionState())[0]?.context_consumed).toBe(1);
  });

  it("prefixes the provider input with the project context packet", async () => {
    const harness = await createHarness({
      formatContextPacket: "Project context packet MARKER-PACKET-42",
    });
    await dispatchHarnessUserTurn(harness, {
      messageId: "context-packet-message",
      text: "What happened?",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const sentInput = harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string };
    expect(sentInput.input).toContain("Project context packet MARKER-PACKET-42");
    expect(sentInput.input).toContain("What happened?");
    expect(sentInput.input?.indexOf("MARKER-PACKET-42") ?? -1).toBeLessThan(
      sentInput.input?.indexOf("What happened?") ?? Number.POSITIVE_INFINITY,
    );
  });

  describe("multi-folder projects", () => {
    const dispatchTurn = (harness: Awaited<ReturnType<typeof createHarness>>, id: string) =>
      dispatchHarnessUserTurn(harness, {
        messageId: `multi-folder-${id}`,
        text: "Rename the shared field",
        createdAt: new Date().toISOString(),
      });

    it("grants the extra folders natively and lists every folder before the message", async () => {
      const harness = await createHarness({
        formatContextPacket: "Project context packet MARKER-PACKET-42",
        projectAdditionalFolders: ["/tmp/provider-api", "/tmp/provider-shared"],
      });
      await dispatchTurn(harness, "grant");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/tmp/provider-project",
        additionalDirectories: ["/tmp/provider-api", "/tmp/provider-shared"],
      });
      const sentInput = (harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string }).input;
      expect(sentInput).toContain("MARKER-PACKET-42");
      expect(sentInput).toContain(
        [
          "<project_folders>",
          "This project spans several folders. You can read and edit all of them:",
          "- provider-project: /tmp/provider-project (primary)",
          "- provider-api: /tmp/provider-api",
          "- provider-shared: /tmp/provider-shared",
        ].join("\n"),
      );
      expect(sentInput?.indexOf("<project_folders>") ?? -1).toBeLessThan(
        sentInput?.indexOf("Rename the shared field") ?? Number.POSITIVE_INFINITY,
      );
    });

    it("does not start a provider without folder grants when the owning project lookup fails", async () => {
      const harness = await createHarness({ projectAdditionalFolders: ["/tmp/provider-api"] });
      const lookup = vi
        .spyOn(harness.projectionSnapshotQuery, "getProjectShellById")
        .mockImplementation(() =>
          Effect.fail(
            new PersistenceSqlError({ operation: "project shell", detail: "lookup unavailable" }),
          ),
        );
      try {
        await dispatchTurn(harness, "lookup-failure");
        await harness.drain();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    });

    it("keeps single-folder projects unchanged", async () => {
      const harness = await createHarness();
      await dispatchTurn(harness, "single");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("additionalDirectories");
      expect(
        (harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string }).input,
      ).not.toContain("<project_folders>");
    });

    it("runs a worktree chat in its worktree and keeps the extra folders live", async () => {
      const harness = await createHarness({ projectAdditionalFolders: ["/tmp/provider-api"] });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("multi-folder-worktree-mode"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          envMode: "worktree",
          branch: "synara/multi-folder",
          worktreePath: "/tmp/provider-worktrees/multi-folder",
        }),
      );
      await dispatchTurn(harness, "worktree");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        cwd: "/tmp/provider-worktrees/multi-folder",
        additionalDirectories: ["/tmp/provider-api"],
      });
      const sentInput = (harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string }).input;
      expect(sentInput).toContain(
        [
          "- multi-folder: /tmp/provider-worktrees/multi-folder (primary, worktree of /tmp/provider-project)",
          "- provider-api: /tmp/provider-api",
          "Edit the primary folder only inside its worktree path above, never in the original checkout. The other folders are not isolated: edits there apply directly.",
        ].join("\n"),
      );
    });

    it.each([
      { sourceDistro: "ubuntu", expectedSource: "/repos/checkout" },
      { sourceDistro: "Debian", expectedSource: "\\\\wsl$\\Debian\\repos\\checkout" },
    ])(
      "describes a WSL worktree's original checkout in $sourceDistro without granting it",
      async ({ sourceDistro, expectedSource }) => {
        const originalCheckout = `\\\\wsl$\\${sourceDistro}\\repos\\checkout`;
        const worktree = "\\\\wsl.localhost\\Ubuntu\\repos\\worktree";
        const extraFolder = "\\\\wsl$\\Ubuntu\\repos\\api";
        const harness = await createHarness({
          threadModelSelection: { provider: "antigravity", model: "gemini-3.1-pro-low" },
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("multi-folder-wsl-project"),
            projectId: asProjectId("project-1"),
            workspaceRoot: originalCheckout,
            additionalFolders: [extraFolder],
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("multi-folder-wsl-worktree"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            envMode: "worktree",
            branch: "synara/multi-folder-wsl",
            worktreePath: worktree,
          }),
        );
        vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));
        try {
          await dispatchTurn(harness, "wsl-worktree");
          await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        } finally {
          vi.unstubAllGlobals();
        }

        expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
          cwd: worktree,
          additionalDirectories: [extraFolder],
        });
        const sentInput = (harness.sendTurn.mock.calls[0]?.[0] as { readonly input?: string })
          .input;
        expect(sentInput).toContain(
          `- worktree: /repos/worktree (primary, worktree of ${expectedSource})\n- api: /repos/api`,
        );
      },
    );

    it("restarts the live session with the edited folders on the next turn", async () => {
      const harness = await createHarness({ projectAdditionalFolders: ["/tmp/provider-api"] });
      await dispatchTurn(harness, "before-edit");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      harness.startSession.mockClear();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("multi-folder-edit-folders"),
          projectId: asProjectId("project-1"),
          additionalFolders: ["/tmp/provider-api", "/tmp/provider-docs"],
        }),
      );
      await harness.drain();
      // Editing the folders never restarts an idle session on its own.
      expect(harness.startSession).not.toHaveBeenCalled();

      await dispatchTurn(harness, "after-edit");
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      const restartInput = harness.startSession.mock.calls[0]?.[1] as {
        readonly additionalDirectories?: ReadonlyArray<string>;
        readonly resumeCursor?: unknown;
      };
      expect(restartInput.additionalDirectories).toEqual([
        "/tmp/provider-api",
        "/tmp/provider-docs",
      ]);
      expect(restartInput.resumeCursor).toBeDefined();
      expect((harness.sendTurn.mock.calls[1]?.[0] as { readonly input?: string }).input).toContain(
        "- provider-docs: /tmp/provider-docs",
      );
      expect(harness.stopSession).not.toHaveBeenCalled();
    });

    it.each([
      { persisted: ["/tmp/provider-api"], restarts: true },
      { persisted: ["/tmp/provider-api", "/tmp/provider-docs"], restarts: false },
    ])(
      "compares a recovered session against its persisted folder grants (restarts: $restarts)",
      async ({ persisted, restarts }) => {
        const modelSelection: ModelSelection = {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
        };
        const harness = await createHarness({
          threadModelSelection: modelSelection,
          projectAdditionalFolders: ["/tmp/provider-api"],
        });
        const threadId = ThreadId.makeUnsafe("thread-1");
        const now = new Date().toISOString();
        // Started outside the reactor, like a runtime prewarmed after a server restart.
        const recovered = await Effect.runPromise(
          harness.startSession(threadId, {
            threadId,
            provider: "claudeAgent",
            modelSelection,
            runtimeMode: "approval-required",
            cwd: "/tmp/provider-project",
            additionalDirectories: persisted,
          }),
        );
        harness.getSessionAdditionalDirectories.mockImplementation(() => Effect.succeed(persisted));
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("seed-recovered-session"),
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
            commandId: CommandId.makeUnsafe("multi-folder-edit-recovered"),
            projectId: asProjectId("project-1"),
            additionalFolders: ["/tmp/provider-api", "/tmp/provider-docs"],
          }),
        );
        await dispatchTurn(harness, "recovered");
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);

        expect(harness.getSessionAdditionalDirectories).toHaveBeenCalledWith(threadId);
        if (restarts) {
          expect(harness.startSession).toHaveBeenCalledTimes(2);
          expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
            additionalDirectories: ["/tmp/provider-api", "/tmp/provider-docs"],
            resumeCursor: recovered.resumeCursor,
          });
        } else {
          expect(harness.startSession).toHaveBeenCalledTimes(1);
        }
        expect(harness.stopSession).not.toHaveBeenCalled();
      },
    );

    it("refuses a provider that cannot be granted the extra folders", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
        projectAdditionalFolders: ["/tmp/provider-api"],
      });
      await dispatchTurn(harness, "provider");

      await waitFor(async () => (await readHarnessThread(harness))?.session?.status === "error");
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.session?.lastError).toContain(
        "cannot access a project's additional folders.",
      );
    });
  });

  it.each(["agent", "automation"] as const)(
    "does not give passive completion context to a %s-originated send",
    async (dispatchOrigin) => {
      const harness = await createHarness();
      await harness.seedCompletion();
      await dispatchHarnessUserTurn(harness, {
        messageId: "completion-agent-message",
        text: "Agent work",
        dispatchOrigin,
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0].input).not.toContain("delegated result");
      expect((await harness.completionState())[0]).toMatchObject({
        context_consumed: 0,
        context_event_sequence: null,
      });
    },
  );

  it("releases completion context after a rejected provider send", async () => {
    const harness = await createHarness();
    await harness.seedCompletion();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "sendTurn",
          issue: "Rejected fixture send",
        }),
      ),
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "completion-rejected-message",
      text: "Try sending",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("delegated result");
    expect((await harness.completionState())[0]).toMatchObject({
      context_consumed: 0,
      context_event_sequence: null,
    });
  });

  function emitStartedBootTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    threadId: ThreadId,
    turnId: TurnId,
  ) {
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.promise(async () => {
        harness.setRuntimeSessionTurnState({ threadId, status: "running", activeTurnId: turnId });
        await harness.emitRuntimeEvent({
          type: "turn.started",
          eventId: asEventId(`started:${turnId}`),
          provider: "codex",
          threadId,
          turnId,
          createdAt: new Date().toISOString(),
          providerRefs: {},
          payload: {},
        });
        await waitFor(
          async () => (await readHarnessThread(harness))?.latestTurn?.turnId === turnId,
        );
        return { threadId, turnId };
      }),
    );
  }

  it("keeps a provider turn started by boot replay live without a crash continuation", async () => {
    const harness = await createHarness({ startReactor: false, ingestRuntimeEvents: true });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("boot-replayed-turn");
    await dispatchHarnessUserTurn(harness, {
      messageId: "boot-replayed-message",
      text: "Pending accepted turn",
      createdAt: new Date().toISOString(),
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    emitStartedBootTurn(harness, threadId, turnId);
    await harness.startReactor();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    const current = await Effect.runPromise(harness.realProviderService.listSessions());
    expect(current).toContainEqual(
      expect.objectContaining({ threadId, activeTurnId: turnId, status: "running" }),
    );
    expect(await harness.runtime.runPromise(captureCrashResumeRecord)).toEqual({ kind: "absent" });
    await harness.runtime.runPromise(
      reconcileRestartStuckTurns.pipe(Effect.provide(ProviderSessionRuntimeRepositoryLive)),
    );
    expect((await readHarnessThread(harness))?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
    });
    const sessionsAfter = await Effect.runPromise(harness.realProviderService.listSessions());
    expect(sessionsAfter).toContainEqual(
      expect.objectContaining({ threadId, activeTurnId: turnId, status: "running" }),
    );
  });

  it("leaves a starting provider turn owned while its native session is still pending", async () => {
    const harness = await createHarness({ ingestRuntimeEvents: true });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("pending-native-start-turn");
    const starting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const startNative = harness.startSessionWithOutcome.getMockImplementation()!;
    harness.startSessionWithOutcome.mockImplementationOnce((...args) =>
      Effect.promise(() => {
        starting.resolve();
        return release.promise;
      }).pipe(Effect.andThen(Effect.suspend(() => startNative(...args)))),
    );
    emitStartedBootTurn(harness, threadId, turnId);
    await dispatchHarnessUserTurn(harness, {
      messageId: "pending-native-start-message",
      text: "Continue the queued work",
      createdAt: new Date().toISOString(),
    });
    try {
      await starting.promise;
      expect(await Effect.runPromise(harness.realProviderService.listSessions())).toEqual([]);
      expect((await readHarnessThread(harness))?.session?.status).toBe("starting");
      const checkStarted = Promise.withResolvers<void>();
      const reconciliation = harness.runtime.runPromise(
        reconcileRestartStuckTurns.pipe(
          Effect.provideService(ProviderCommandReactor, {
            ...harness.reactor,
            withRestartOrphanedThread: (id, effect) =>
              Effect.suspend(() => {
                checkStarted.resolve();
                return harness.reactor.withRestartOrphanedThread(id, effect);
              }),
          }),
          Effect.provide(ProviderSessionRuntimeRepositoryLive),
        ),
      );
      await checkStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await readHarnessThread(harness))?.session?.status).toBe("starting");
      release.resolve();
      await reconciliation;
      expect((await readHarnessThread(harness))?.session).toMatchObject({
        status: "running",
        activeTurnId: turnId,
      });
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
  });

  it.each(["thread.turn.interrupt", "thread.session.stop"] as const)(
    "replays a pending %s before considering crash continuation",
    async (type) => {
      const harness = await createHarness({ startReactor: false });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId("old-running-turn-with-stop");
      const createdAt = new Date().toISOString();
      const original = await dispatchHarnessUserTurn(harness, {
        messageId: "old-message-with-stop",
        text: "Original work",
        createdAt,
      });
      const originalDelivery = {
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: original.sequence,
        claimOwner: "previous-process",
      };
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          ...originalDelivery,
          threadId,
          claimedAt: createdAt,
          claimExpiresAt: createdAt,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.complete({
          ...originalDelivery,
          completedAt: createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("old-running-session-with-stop"),
          threadId,
          session: {
            threadId,
            providerName: "codex",
            runtimeMode: "approval-required",
            status: "running",
            activeTurnId: turnId,
            updatedAt: createdAt,
            lastError: null,
          },
          createdAt,
        }),
      );
      const control = {
        commandId: CommandId.makeUnsafe("pending-durable-stop"),
        threadId,
        createdAt,
      };
      await Effect.runPromise(
        harness.engine.dispatch(
          type === "thread.turn.interrupt"
            ? { ...control, type, turnId, requestedBy: "user" }
            : { ...control, type },
        ),
      );
      expect((await readHarnessThread(harness))?.session?.activeTurnId).toBe(turnId);
      const capture = () => harness.runtime.runPromise(captureCrashResumeRecord);
      expect(await capture()).toMatchObject({
        kind: "record",
        record: { threads: [{ threadId, turnId }] },
      });
      await harness.startReactor();
      expect((await readHarnessThread(harness))?.session?.activeTurnId).toBeNull();
      expect(await capture()).toEqual({ kind: "absent" });
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  // #1900: a full thread detail read (every message plus the whole activity
  // timeline) once ran 18+ times per turn and took seconds on long threads.
  // Drive one scripted turn through command dispatch and runtime ingestion and
  // count the detail reads, so the next hot-path caller that regresses fails here.
  it("drives a scripted turn without full thread detail reads", async () => {
    const harness = await createHarness({ ingestRuntimeEvents: true });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const detailReads = vi.spyOn(harness.projectionSnapshotQuery, "getThreadDetailById");
    const activityFreeDetailReads = vi.spyOn(
      harness.projectionSnapshotQuery,
      "getThreadDetailWithoutActivitiesById",
    );
    await dispatchHarnessUserTurn(harness, {
      messageId: "scripted-turn-message",
      text: "Refactor the session store",
      createdAt: new Date().toISOString(),
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    const turnId = asTurnId("scripted-turn");
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: turnId,
    });
    const eventBase = (eventId: string) =>
      ({
        eventId: asEventId(`scripted-turn-${eventId}`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        providerRefs: {},
      }) as const;
    await harness.emitRuntimeEvent({ ...eventBase("started"), type: "turn.started", payload: {} });
    const assistantItems = 5;
    for (let index = 0; index < assistantItems; index += 1) {
      const itemId = RuntimeItemId.makeUnsafe(`scripted-assistant-${index}`);
      await harness.emitRuntimeEvent({
        ...eventBase(`assistant-delta-${index}`),
        type: "content.delta",
        itemId,
        payload: { streamKind: "assistant_text", delta: `Step ${index}.` },
      });
      await harness.emitRuntimeEvent({
        ...eventBase(`assistant-completed-${index}`),
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      });
    }
    // Codex emits a turn diff after every patch, so each file change gets one.
    // Several diff events keep a diff-path regression above the bound below.
    for (let index = 0; index < 3; index += 1) {
      await harness.emitRuntimeEvent({
        ...eventBase(`file-change-${index}`),
        type: "item.completed",
        itemId: RuntimeItemId.makeUnsafe(`scripted-file-change-${index}`),
        payload: {
          itemType: "file_change",
          status: "completed",
          title: "Edited file",
          detail: `src/file-${index}.ts`,
          data: { changes: [{ path: `src/file-${index}.ts`, kind: "update" }] },
        },
      });
      await harness.emitRuntimeEvent({
        ...eventBase(`diff-${index}`),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: [
            `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
            `--- a/src/file-${index}.ts`,
            `+++ b/src/file-${index}.ts`,
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "",
          ].join("\n"),
        },
      });
    }
    harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
    await harness.emitRuntimeEvent({
      ...eventBase("completed"),
      type: "turn.completed",
      payload: { state: "completed" },
    });
    await waitFor(
      async () => (await readHarnessThread(harness))?.latestTurn?.state === "completed",
    );
    await harness.drain();

    expect(detailReads).not.toHaveBeenCalled();
    // Turn dispatch builds its bootstrap from messages (1); ingestion reads
    // messages for each assistant completion (K) and the terminal event (1).
    // No slack: one more read per diff event or file change must fail here.
    expect(activityFreeDetailReads.mock.calls.length).toBeGreaterThan(0);
    expect(activityFreeDetailReads.mock.calls.length).toBeLessThanOrEqual(assistantItems + 2);
  });
});

describe("awaitInflightClaimSettlement", () => {
  it("waits out the deadline when the claim never settles", async () => {
    const startedAt = Date.now();
    const result = await Effect.runPromise(
      awaitInflightClaimSettlement({
        readClaim: () =>
          Effect.succeed({
            state: "inflight",
            claimOwner: "owner-a",
            claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        deadlineMs: 60,
        pollIntervalMs: 10,
      }),
    );
    expect(result).toMatchObject({ state: "inflight" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("wakes early when the claim settles mid-wait", async () => {
    let reads = 0;
    const startedAt = Date.now();
    const result = await Effect.runPromise(
      awaitInflightClaimSettlement({
        readClaim: () =>
          Effect.sync(() => {
            reads += 1;
            return reads < 3
              ? {
                  state: "inflight",
                  claimOwner: "owner-a",
                  claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                }
              : { state: "succeeded", claimOwner: "owner-a", claimExpiresAt: null };
          }),
        deadlineMs: 5_000,
        pollIntervalMs: 5,
      }),
    );
    expect(result).toMatchObject({ state: "succeeded" });
    expect(reads).toBe(3);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
