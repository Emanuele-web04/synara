// FILE: ProviderCommandReactor.claudeCacheReview.test.ts
// Purpose: ProviderCommandReactor cases for Claude cache review, durable title regeneration, and the cases that follow them.
// Layer: Orchestration integration tests
// Depends on: providerCommandReactorHarness (ProviderCommandReactorLive with in-memory provider
//             and persistence services).
// Note: one contiguous slice of the former single ProviderCommandReactor.test.ts, in its
//       original order, so CI can run the slices on separate workers.

import * as betaOperationalIssue from "../../betaOperationalIssue";
import type {
  ClaudeCacheObservation,
  ModelSelection,
  OrchestrationCommand,
  ProviderRuntimeEvent,
} from "@synara/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Duration, Deferred, Effect, Fiber, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../computer/FakeComputerBackend.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterValidationError,
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  providerThreadProcessedConsumerName,
} from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import {
  OrchestrationCommandInternalError,
  OrchestrationCommandInvariantError,
} from "../Errors.ts";
import {
  asProjectId,
  asEventId,
  asMessageId,
  asTurnId,
  expiredCacheObservation,
  waitFor,
  useProviderCommandReactorHarness,
} from "../testing/providerCommandReactorHarness.ts";

describe("ProviderCommandReactor", () => {
  const { createHarness, seedRollbackTarget, readHarnessThread, dispatchHarnessUserTurn } =
    useProviderCommandReactorHarness();

  async function seedRenameConversation(
    harness: Awaited<ReturnType<typeof createHarness>>,
    userText = "Fix the backend authentication callback race",
  ) {
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe(`cmd-rename-context-${crypto.randomUUID()}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messages: [
          {
            messageId: asMessageId(`rename-user-${crypto.randomUUID()}`),
            role: "user",
            text: userText,
            createdAt,
            updatedAt: createdAt,
          },
          {
            messageId: asMessageId(`rename-assistant-${crypto.randomUUID()}`),
            role: "assistant",
            text: "I found the race in the callback state transition.",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        createdAt,
      }),
    );
  }

  describe("Claude cache review", () => {
    async function createCacheHarness(
      observation: () => ClaudeCacheObservation | undefined = expiredCacheObservation,
      startReactor = true,
    ) {
      return createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation: () => Effect.sync(observation),
        startReactor,
      });
    }

    async function sendHeldMessage(harness: Awaited<ReturnType<typeof createHarness>>) {
      await dispatchHarnessUserTurn(harness, {
        messageId: "cache-held-message",
        text: "Continue with this exact message",
        createdAt: new Date().toISOString(),
      });
      await waitFor(
        async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "pending",
      );
      await harness.drain();
      const review = (await readHarnessThread(harness))?.claudeCacheReview;
      expect(review).toBeTruthy();
      return review!;
    }

    async function respondToReview(
      harness: Awaited<ReturnType<typeof createHarness>>,
      review: NonNullable<Awaited<ReturnType<typeof readHarnessThread>>>["claudeCacheReview"],
      decision: "continue" | "compact" | "cancel",
      suffix: string = decision,
    ) {
      const command: OrchestrationCommand = {
        type: "thread.claude-cache.respond",
        commandId: CommandId.makeUnsafe(`cmd-cache-${suffix}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        reviewId: review!.reviewId,
        messageId: review!.messageId,
        decision,
        createdAt: new Date().toISOString(),
      };
      await Effect.runPromise(harness.engine.dispatch(command));
      await harness.drain();
      return command;
    }

    async function createCompactionHarness(
      cancelClaudeCompactionDiscovery?: NonNullable<
        ProviderServiceShape["cancelClaudeCompactionDiscovery"]
      >,
      ingestRuntimeEvents = false,
      commandEventTimeout?: Duration.Duration,
    ) {
      let observation = expiredCacheObservation();
      const startClaudeCompaction = vi.fn<
        NonNullable<ProviderServiceShape["startClaudeCompaction"]>
      >(({ threadId, turnId }) => Effect.succeed({ threadId, turnId }));
      const getClaudeCacheObservation = vi.fn(() => Effect.sync(() => observation));
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation,
        startClaudeCompaction,
        ingestRuntimeEvents,
        ...(commandEventTimeout ? { commandEventTimeout } : {}),
        ...(cancelClaudeCompactionDiscovery ? { cancelClaudeCompactionDiscovery } : {}),
      });
      return {
        harness,
        startClaudeCompaction,
        getClaudeCacheObservation,
        setObservation: (next: ClaudeCacheObservation) => {
          observation = next;
        },
      };
    }

    async function emitCompactionTerminal(
      harness: Awaited<ReturnType<typeof createHarness>>,
      turnId: TurnId,
      input: {
        readonly state: "completed" | "failed" | "cancelled" | "aborted";
        readonly contextCompacted?: boolean;
      },
      suffix: string = input.state,
    ) {
      harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
      const base = {
        eventId: asEventId(`evt-cache-compaction-${suffix}`),
        provider: "claudeAgent" as const,
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
        turnId,
        providerRefs: {},
      };
      await harness.emitRuntimeEvent(
        input.state === "aborted"
          ? { ...base, type: "turn.aborted", payload: { reason: "Compaction interrupted" } }
          : ({
              ...base,
              type: "turn.completed",
              payload: {
                state: input.state,
                ...(input.contextCompacted !== undefined
                  ? { contextCompacted: input.contextCompacted }
                  : {}),
              },
            } as ProviderRuntimeEvent),
      );
      await harness.drain();
    }

    // A held message whose source delivery a previous process already completed.
    async function seedRecoveredHeldCacheSource(
      harness: Awaited<ReturnType<typeof createHarness>>,
      observation: ClaudeCacheObservation,
      now: string,
      input: {
        readonly messageId: string;
        readonly reviewId: string;
        readonly text: string;
        readonly setCommandId: string;
      },
    ) {
      const threadId = ThreadId.makeUnsafe("thread-1");
      const source = await dispatchHarnessUserTurn(harness, {
        messageId: input.messageId,
        text: input.text,
        createdAt: now,
      });
      const review = {
        reviewId: input.reviewId,
        messageId: asMessageId(input.messageId),
        sourceEventSequence: source.sequence,
        assessment: observation,
        status: "pending" as const,
        createdAt: now,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe(input.setCommandId),
          threadId,
          review,
          expectedReviewId: null,
          createdAt: now,
        }),
      );
      const key = {
        consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
        eventSequence: source.sequence,
      };
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          ...key,
          threadId,
          claimOwner: "previous-process",
          claimedAt: now,
          claimExpiresAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.complete({
          ...key,
          claimOwner: "previous-process",
          completedAt: now,
        }),
      );
      return { source, review, key };
    }

    it("recovers a retryable cache response ahead of the source cursor before source admission", async () => {
      const observation = expiredCacheObservation();
      const harness = await createCacheHarness(() => observation, false);
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      const {
        source,
        review,
        key: sourceKey,
      } = await seedRecoveredHeldCacheSource(harness, observation, now, {
        messageId: "cache-retry-ahead-message",
        reviewId: "cache-retry-ahead-review",
        text: "Continue this recovered held message",
        setCommandId: "cmd-cache-retry-ahead-review",
      });
      const response = await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.respond",
          commandId: CommandId.makeUnsafe("cmd-cache-retry-ahead-continue"),
          threadId,
          reviewId: review.reviewId,
          messageId: review.messageId,
          decision: "continue",
          createdAt: now,
        }),
      );
      const responseKey = { ...sourceKey, eventSequence: response.sequence };
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          ...responseKey,
          threadId,
          claimOwner: "previous-process",
          claimedAt: now,
          claimExpiresAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.markRetryable({
          ...responseKey,
          expectedClaimOwner: "previous-process",
          error: "Previous process confirmed rejection before provider dispatch",
          updatedAt: now,
        }),
      );
      const before = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
        ),
      );
      expect(before.lastAckedSequence).toBeLessThan(response.sequence);

      await harness.startReactor();
      await harness.drain();

      expect(
        Option.getOrThrow(
          await Effect.runPromise(harness.deliveryRepository.getDelivery(responseKey)),
        ),
      ).toMatchObject({ state: "succeeded", attemptCount: 2 });
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        input: expect.stringContaining("Continue this recovered held message"),
      });
      const after = Option.getOrThrow(
        await Effect.runPromise(
          harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
        ),
      );
      expect(after.lastAckedSequence).toBeGreaterThanOrEqual(response.sequence);
    });

    it.each(["inflight", "retry"] as const)(
      "recovers a fenced %s cache response after restart while another lane pins ACK",
      async (state) => {
        const observation = expiredCacheObservation();
        const harness = await createCacheHarness(() => observation, false);
        const threadId = ThreadId.makeUnsafe("thread-1");
        const now = new Date().toISOString();
        const { source, review, key } = await seedRecoveredHeldCacheSource(
          harness,
          observation,
          now,
          {
            messageId: `cache-fenced-${state}-message`,
            reviewId: `cache-fenced-${state}-review`,
            text: "Recover this saved cache response",
            setCommandId: `cache-fenced-${state}-review-set`,
          },
        );
        const peer = ThreadId.makeUnsafe(`cache-fenced-${state}-peer`);
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe(`cache-fenced-${state}-peer-create`),
            threadId: peer,
            projectId: asProjectId("project-1"),
            title: "Pinned peer",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
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
            commandId: CommandId.makeUnsafe(`cache-fenced-${state}-peer-session`),
            threadId: peer,
            session: {
              threadId: peer,
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              updatedAt: now,
              lastError: null,
            },
            createdAt: now,
          }),
        );
        const prefix = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
        for (const event of prefix)
          await Effect.runPromise(
            harness.deliveryRepository.advanceCursor({
              consumerName: key.consumerName,
              eventSequence: event.sequence,
              updatedAt: now,
            }),
          );
        const pinned = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.task.stop",
            commandId: CommandId.makeUnsafe(`cache-fenced-${state}-peer-pin`),
            threadId: peer,
            taskId: "pinned-peer-task",
            createdAt: now,
          }),
        );
        const response = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.respond",
            commandId: CommandId.makeUnsafe(`cache-fenced-${state}-continue`),
            threadId,
            reviewId: review.reviewId,
            messageId: review.messageId,
            decision: "continue",
            createdAt: now,
          }),
        );
        const responseKey = { ...key, eventSequence: response.sequence };
        await Effect.runPromise(
          harness.deliveryRepository.claim({
            ...responseKey,
            threadId,
            claimOwner: "previous-process",
            claimedAt: now,
            claimExpiresAt: now,
          }),
        );
        if (state === "retry")
          await Effect.runPromise(
            harness.deliveryRepository.markRetryable({
              ...responseKey,
              expectedClaimOwner: "previous-process",
              error: "Confirmed pre-dispatch rejection",
              updatedAt: now,
            }),
          );
        // Prior quarantine left a durable fence covering a later asynchronous
        // cache response, whose source lane completed at claim rather than send.
        await Effect.runPromise(
          harness.deliveryRepository.recordThreadProcessedSequence({
            threadId,
            eventSequence: response.sequence,
            updatedAt: now,
          }),
        );
        expect(
          await Effect.runPromise(
            harness.deliveryRepository.listRetryableDeliveries(key.consumerName),
          ),
        ).toEqual([]);
        const fresh = await harness.restartReactor();
        const entered = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        harness.stopTask.mockImplementation(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        const startup = fresh.start();
        try {
          await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("1 second")));
          await waitFor(
            async () =>
              Option.getOrUndefined(
                await Effect.runPromise(harness.deliveryRepository.getDelivery(responseKey)),
              )?.state === (state === "retry" ? "succeeded" : "uncertain"),
          );
          expect(
            Option.getOrThrow(
              await Effect.runPromise(
                harness.deliveryRepository.getConsumerState(key.consumerName),
              ),
            ).lastAckedSequence,
          ).toBeLessThan(pinned.sequence);
          if (state === "inflight")
            await waitFor(
              async () =>
                (await readHarnessThread(harness))?.claudeCacheReview?.status === "uncertain",
            );
          expect(harness.sendTurn).toHaveBeenCalledTimes(state === "retry" ? 1 : 0);
        } finally {
          await Effect.runPromise(Deferred.succeed(release, undefined));
          await startup;
        }
        if (state === "retry") {
          const beforeFence = await Effect.runPromise(
            harness.deliveryRepository.getConsumerState(
              providerThreadProcessedConsumerName(threadId),
            ),
          );
          const callsBefore = harness.stopTask.mock.calls.length;
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.task.stop",
              commandId: CommandId.makeUnsafe("cache-fenced-normal-after-recovery"),
              threadId,
              taskId: "normal-task",
              createdAt: now,
            }),
          );
          await waitFor(() => harness.stopTask.mock.calls.length > callsBefore);
          await Effect.runPromise(fresh.reactor.drain);
          expect(
            await Effect.runPromise(
              harness.deliveryRepository.getConsumerState(
                providerThreadProcessedConsumerName(threadId),
              ),
            ),
          ).toEqual(beforeFence);
        }
      },
    );

    it("retains completion context while parked and consumes it only after Continue sends", async () => {
      const { harness } = await createCompactionHarness();
      await harness.seedCompletion();
      const review = await sendHeldMessage(harness);
      expect((await harness.completionState())[0]).toMatchObject({
        context_consumed: 0,
        context_event_sequence: null,
      });
      await respondToReview(harness, review, "continue");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toContain("delegated result");
      expect((await harness.completionState())[0]?.context_consumed).toBe(1);
    });

    it.each([
      "thread.session.stop",
      "thread.turn.interrupt",
      "thread.archive",
      "thread.delete",
      "thread.conversation.rollback",
      "thread.message.edit-and-resend",
    ] as const)("cancels discovery before delivering a queued UI %s", async (commandType) => {
      let releaseDiscovery!: () => void;
      const discovery = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      const cancelDiscovery = vi.fn((threadId: ThreadId) =>
        Effect.sync(() => {
          expect(threadId).toBe("thread-1");
          releaseDiscovery();
        }),
      );
      const { harness, startClaudeCompaction, getClaudeCacheObservation } =
        await createCompactionHarness(
          cancelDiscovery,
          commandType === "thread.message.edit-and-resend",
        );
      const editsNativeCommand = commandType === "thread.message.edit-and-resend";
      if (editsNativeCommand) {
        getClaudeCacheObservation.mockReturnValue(
          Effect.succeed({
            ...expiredCacheObservation(),
            state: "likely-warm",
            contextTokens: 16_000,
            lastResponseAt: new Date().toISOString(),
          }),
        );
      }
      if (commandType === "thread.conversation.rollback") {
        await seedRollbackTarget(harness, {
          messageId: asMessageId("before-compaction-history"),
          turnId: asTurnId("before-compaction-turn"),
          createdAt: new Date().toISOString(),
        });
      }
      const preparation = editsNativeCommand ? harness.sendTurn : startClaudeCompaction;
      preparation.mockImplementationOnce(() =>
        Effect.promise(() => discovery).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterValidationError({
                provider: "claudeAgent",
                operation: "startClaudeCompaction",
                issue: "Compaction discovery cancelled before dispatch.",
              }),
            ),
          ),
        ),
      );
      const review = editsNativeCommand ? undefined : await sendHeldMessage(harness);
      try {
        if (editsNativeCommand) {
          await dispatchHarnessUserTurn(harness, {
            messageId: "native-compaction-command",
            text: "/compact",
            createdAt: new Date().toISOString(),
          });
        } else {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-queued-stop-compact"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review!.reviewId,
              messageId: review!.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
        }
        await waitFor(() => preparation.mock.calls.length === 1);
        if (editsNativeCommand) {
          const turnId = asTurnId("native-compaction-preparation");
          harness.setRuntimeSessionTurnState({
            threadId: "thread-1",
            status: "running",
            activeTurnId: turnId,
          });
          await harness.emitRuntimeEvent({
            type: "turn.started",
            eventId: asEventId("native-compaction-started"),
            provider: "claudeAgent",
            createdAt: new Date().toISOString(),
            threadId: ThreadId.makeUnsafe("thread-1"),
            turnId,
            payload: {},
            providerRefs: {},
          });
          await waitFor(
            async () => (await readHarnessThread(harness))?.session?.activeTurnId === turnId,
          );
        }
        // Fill the ordered source's bounded handoff with unrelated events.
        for (const index of [1, 2, 3]) {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(`cmd-discovery-title-${index}`),
              threadId: ThreadId.makeUnsafe("thread-1"),
              title: `Title ${index}`,
            }),
          );
        }
        const cancellationCommand: OrchestrationCommand =
          commandType === "thread.conversation.rollback"
            ? {
                type: commandType,
                commandId: CommandId.makeUnsafe("cmd-stop-during-discovery"),
                threadId: ThreadId.makeUnsafe("thread-1"),
                messageId: asMessageId("before-compaction-history"),
                numTurns: 1,
                createdAt: new Date().toISOString(),
              }
            : commandType === "thread.message.edit-and-resend"
              ? {
                  type: commandType,
                  commandId: CommandId.makeUnsafe("cmd-edit-during-compaction"),
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  messageId: asMessageId("native-compaction-command"),
                  text: "Replace the compaction command",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  createdAt: new Date().toISOString(),
                }
              : {
                  type: commandType,
                  commandId: CommandId.makeUnsafe("cmd-stop-during-discovery"),
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  createdAt: new Date().toISOString(),
                };
        await Effect.runPromise(harness.engine.dispatch(cancellationCommand));
        await expect.poll(() => cancelDiscovery.mock.calls.length).toBe(1);
        await harness.drain();
        if (commandType === "thread.turn.interrupt") {
          // Discovery was cancelled above; its idle provider has no turn to interrupt.
          expect(harness.interruptTurn).not.toHaveBeenCalled();
        } else if (commandType === "thread.conversation.rollback") {
          expect(harness.rollbackConversation).toHaveBeenCalledTimes(1);
        } else if (commandType === "thread.session.stop" || commandType === "thread.archive") {
          expect(harness.stopRuntimeSession).toHaveBeenCalledTimes(1);
        }
        if (editsNativeCommand) {
          harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
          await harness.emitRuntimeEvent({
            type: "turn.completed",
            eventId: asEventId("native-compaction-cancelled"),
            provider: "claudeAgent",
            createdAt: new Date().toISOString(),
            threadId: ThreadId.makeUnsafe("thread-1"),
            turnId: asTurnId("native-compaction-preparation"),
            payload: { state: "interrupted", contextCompacted: false },
            providerRefs: {},
          });
          await waitFor(() => harness.sendTurn.mock.calls.length === 2);
          await harness.drain();
          expect(harness.sendTurn.mock.calls.map(([input]) => input.input)).toEqual([
            "/compact",
            "Replace the compaction command",
          ]);
        } else {
          expect(harness.sendTurn).not.toHaveBeenCalled();
        }
      } finally {
        releaseDiscovery();
      }
    });

    it.each([
      "startup",
      "preflight",
      "baseline",
      "replay",
      "queued-stop",
      "subscriber-lag",
      "idle-interrupt",
      "queued-rollback",
      "service-cancel",
      "startup-cleanup-failure",
    ] as const)("retains direct /compact cancellation during %s", async (phase) => {
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      const cancelDiscovery = vi.fn(() => Effect.void);
      const observation = {
        ...expiredCacheObservation(),
        state: "likely-warm" as const,
        contextTokens: 16_000,
        lastResponseAt: new Date().toISOString(),
      };
      const getObservation = vi.fn(() => Effect.succeed(observation));
      const captureBaselineBeforeTurn = vi.fn(() =>
        Effect.promise(() => preparation).pipe(Effect.as({ status: "completed" as const })),
      );
      let releaseSubscriber!: () => void;
      let subscriberEntered = false;
      const subscriberGate = new Promise<void>((resolve) => {
        releaseSubscriber = resolve;
      });
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        startReactor: phase !== "replay" && phase !== "subscriber-lag",
        getClaudeCacheObservation: getObservation,
        ...(phase === "baseline" ? { hubOutputReactor: { captureBaselineBeforeTurn } } : {}),
        cancelClaudeCompactionDiscovery: cancelDiscovery,
      });
      if (phase === "idle-interrupt" || phase === "service-cancel") {
        await dispatchHarnessUserTurn(harness, {
          messageId: "before-idle-compact",
          text: "Initial task",
          createdAt: new Date().toISOString(),
        });
        await harness.drain();
        harness.sendTurn.mockClear();
        getObservation.mockClear();
      }
      if (phase === "queued-rollback") {
        await seedRollbackTarget(harness, {
          messageId: asMessageId("prior-rollback-history"),
          turnId: asTurnId("prior-rollback-turn"),
          createdAt: new Date().toISOString(),
        });
      }
      if (phase === "startup" || phase === "startup-cleanup-failure") {
        const startSession = harness.startSession.getMockImplementation()!;
        harness.startSession.mockImplementationOnce((...args) =>
          Effect.promise(() => preparation).pipe(
            Effect.flatMap(() => startSession(...args)),
            Effect.onInterrupt(() =>
              phase === "startup-cleanup-failure"
                ? Effect.fail(
                    new ProviderAdapterProcessError({
                      provider: "claudeAgent",
                      threadId: "thread-1",
                      detail: "Cancelled startup cleanup did not prove process-tree exit.",
                    }),
                  )
                : Effect.void,
            ),
          ),
        );
      } else if (phase === "service-cancel") {
        harness.sendTurn.mockImplementationOnce((_, options) =>
          Effect.promise(() => preparation).pipe(
            Effect.andThen(Deferred.await(options!.claudeCompactionCancellation!)),
            Effect.andThen(
              Effect.fail(
                new ProviderValidationError({
                  operation: "ProviderService.sendTurn",
                  issue: "Claude compaction preparation was cancelled. Try again.",
                }),
              ),
            ),
          ),
        );
      } else if (phase !== "replay" && phase !== "baseline") {
        getObservation.mockImplementationOnce(() =>
          Effect.promise(() => preparation).pipe(Effect.as(observation)),
        );
      }
      if (phase === "subscriber-lag") {
        const subscribe = harness.engine.subscribeDomainEvents;
        let subscriptions = 0;
        Object.assign(harness.engine, {
          subscribeDomainEvents: Effect.suspend(() => {
            const delaysCancellation = subscriptions++ === 0;
            return subscribe.pipe(
              Effect.map((events) =>
                delaysCancellation
                  ? events.pipe(
                      Stream.mapEffect((event) =>
                        Effect.gen(function* () {
                          if (event.type === "thread.turn-interrupt-requested") {
                            subscriberEntered = true;
                            yield* Effect.promise(() => subscriberGate);
                          }
                          return event;
                        }),
                      ),
                    )
                  : events,
              ),
            );
          }),
        });
        await harness.startReactor();
      }
      let queuedSequence: number | undefined;
      try {
        await dispatchHarnessUserTurn(harness, {
          messageId: "direct-compact-before-cancel",
          text: "/compact Preserve project decisions",
          createdAt: new Date().toISOString(),
        });
        if (phase !== "replay") {
          await waitFor(() =>
            phase === "startup" || phase === "startup-cleanup-failure"
              ? harness.startSession.mock.calls.length === 1
              : phase === "baseline"
                ? captureBaselineBeforeTurn.mock.calls.length === 1
                : phase === "service-cancel"
                  ? harness.sendTurn.mock.calls.length === 1
                  : getObservation.mock.calls.length === 1,
          );
        }
        if (phase === "queued-stop" || phase === "queued-rollback") {
          const createdAt = new Date().toISOString();
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.makeUnsafe("cmd-compact-preparing-session"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              session: {
                threadId: ThreadId.makeUnsafe("thread-1"),
                providerName: "claudeAgent",
                runtimeMode: "approval-required",
                status: "running",
                activeTurnId: asTurnId("preparing-native-compact"),
                lastError: null,
                updatedAt: createdAt,
              },
              createdAt,
            }),
          );
          await dispatchHarnessUserTurn(harness, {
            messageId: "queued-behind-cancelled-compact",
            text: "This queued message must stay cancelled",
            createdAt: new Date().toISOString(),
          });
          const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
          const queuedEvent = events.find(
            (event) =>
              event.type === "thread.turn-queued" &&
              event.payload.messageId === "queued-behind-cancelled-compact",
          );
          expect(queuedEvent).toBeDefined();
          queuedSequence = queuedEvent!.sequence;
        }
        await Effect.runPromise(
          harness.engine.dispatch(
            phase === "queued-rollback"
              ? {
                  type: "thread.conversation.rollback",
                  commandId: CommandId.makeUnsafe("cmd-cancel-compact-rollback"),
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  messageId: asMessageId("prior-rollback-history"),
                  numTurns: 1,
                  createdAt: new Date().toISOString(),
                }
              : {
                  type:
                    phase === "preflight" ||
                    phase === "baseline" ||
                    phase === "subscriber-lag" ||
                    phase === "idle-interrupt" ||
                    phase === "service-cancel"
                      ? "thread.turn.interrupt"
                      : "thread.session.stop",
                  commandId: CommandId.makeUnsafe(`cmd-direct-compact-cancel-${phase}`),
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  createdAt: new Date().toISOString(),
                },
          ),
        );
        if (phase === "replay") await harness.startReactor();
        else if (phase === "subscriber-lag") await waitFor(() => subscriberEntered);
        else await waitFor(() => cancelDiscovery.mock.calls.length === 1);
        if (phase === "startup-cleanup-failure") {
          await waitFor(async () => {
            const blockers = await Effect.runPromise(
              harness.reactor.listBlockingDeliveries({ limit: 10 }),
            );
            return blockers.some(
              (blocker) =>
                blocker.state === "uncertain" &&
                blocker.lastError?.includes("did not prove process-tree exit"),
            );
          });
          expect(harness.sendTurn).not.toHaveBeenCalled();
          return;
        }
        if (phase === "startup" || phase === "preflight" || phase === "baseline") {
          await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeout(Duration.seconds(1))));
        }
        releasePreparation();
        await harness.drain();
        if (phase === "service-cancel") {
          expect(harness.sendTurn).toHaveBeenCalledTimes(1);
          harness.sendTurn.mockClear();
          expect(
            (await readHarnessThread(harness))?.activities.some(
              (activity) => activity.kind === "provider.turn.start.failed",
            ),
          ).toBe(false);
        } else expect(harness.sendTurn).not.toHaveBeenCalled();
        if (phase === "idle-interrupt" || phase === "service-cancel") {
          expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.session?.status).toBe("ready");
        }
        if (phase === "queued-rollback") {
          const promotion = await Effect.runPromise(
            harness.queuedTurnPromotionRepository.getBySequence(queuedSequence!),
          );
          expect(Option.getOrThrow(promotion).state).toBe("queued");
          expect(
            (await readHarnessThread(harness))?.activities.some(
              (activity) => activity.kind === "provider.turn.start.failed",
            ),
          ).toBe(false);
        }
        releaseSubscriber();
        await dispatchHarnessUserTurn(harness, {
          messageId: "direct-compact-new-choice",
          text: "/compact Keep the active task",
          createdAt: new Date().toISOString(),
        });
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await harness.drain();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        if (phase === "idle-interrupt" || phase === "service-cancel")
          expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("/compact Keep the active task");
        const options = harness.sendTurn.mock.calls[0]?.[1];
        expect(options?.claudeCompactionCancellation).toBeDefined();
        expect(Effect.runSync(Deferred.isDone(options!.claudeCompactionCancellation!))).toBe(false);
      } finally {
        releasePreparation();
        releaseSubscriber();
      }
    });

    it.each([
      ["queue", "model"],
      ["steer", "model"],
      ["queue", "runtime"],
      ["steer", "runtime"],
      ["queue", "computer"],
      ["steer", "computer"],
    ] as const)(
      "defers spawn-fixed selections during direct /compact (%s, %s)",
      async (dispatchMode, changedSetting) => {
        const manager = new ComputerManager({ backend: new FakeComputerBackend() });
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
          computerService: {
            supported: true,
            availability: { kind: "available", backend: "fake" },
            manager,
          },
          getClaudeCacheObservation: () =>
            Effect.succeed({
              ...expiredCacheObservation(),
              state: "likely-warm",
              contextTokens: 16_000,
            }),
        });
        try {
          const send = (id: string, text: string, modelSelection?: ModelSelection) =>
            Effect.runPromise(
              harness.engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe(id),
                threadId: ThreadId.makeUnsafe("thread-1"),
                message: { messageId: asMessageId(id), role: "user", text, attachments: [] },
                interactionMode: "default",
                runtimeMode:
                  changedSetting === "runtime" && modelSelection
                    ? "full-access"
                    : "approval-required",
                dispatchMode,
                ...(modelSelection ? { modelSelection } : {}),
                ...(changedSetting === "computer" && modelSelection
                  ? { enableComputerControl: true, computerControlGeneration: 0 }
                  : {}),
                createdAt: new Date().toISOString(),
              }),
            );
          await send("before-compact-settings", "Initial task");
          await harness.drain();
          const selection: ModelSelection = {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: { effort: "max", autoCompactWindow: "200k" },
          };
          await send("compact-pending-settings", "/compact Keep project decisions", selection);
          await harness.drain();
          expect(harness.startSession).toHaveBeenCalledTimes(1);
          expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
          expect(manager.canContinueChatControl("thread-1")).toBe(false);
          expect(harness.sendTurn.mock.calls.map(([input]) => input.input)).toEqual([
            "Initial task",
            "/compact Keep project decisions",
          ]);
          await send("ordinary-pending-settings", "Continue with these settings", selection);
          await harness.drain();
          expect(harness.startSession).toHaveBeenCalledTimes(2);
          expect(harness.startSession.mock.calls[1]?.[1].modelSelection).toEqual({
            ...selection,
            instanceId: "claudeAgent",
          });
          expect(harness.startSession.mock.calls[1]?.[1].runtimeMode).toBe(
            changedSetting === "runtime" ? "full-access" : "approval-required",
          );
          expect(manager.canContinueChatControl("thread-1")).toBe(changedSetting === "computer");
        } finally {
          await manager.dispose();
        }
      },
    );

    it("uses the persisted Claude profile when native compaction resumes a stopped runtime", async () => {
      const savedSelection: ModelSelection = {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "high", autoCompactWindow: "200k" },
      };
      const pendingSelection: ModelSelection = {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "max", autoCompactWindow: "200k" },
      };
      const getPersistedSessionProfile = vi.fn(() =>
        Effect.succeed({
          provider: "claudeAgent" as const,
          modelSelection: savedSelection,
          runtimeMode: "approval-required" as const,
          enableComputerControl: true,
        }),
      );
      const harness = await createHarness({
        threadModelSelection: pendingSelection,
        getPersistedSessionProfile,
        getClaudeCacheObservation: () => Effect.succeed(undefined),
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-cold-native-compact"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("cold-native-compact"),
            role: "user",
            text: "/compact Keep the established context",
            attachments: [],
          },
          interactionMode: "default",
          modelSelection: pendingSelection,
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();
      expect(getPersistedSessionProfile).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-1"));
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        modelSelection: savedSelection,
        runtimeMode: "approval-required",
        enableComputerControl: true,
      });
      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe(
        "/compact Keep the established context",
      );
    });

    it("retains compaction cancellation when a native steer settles during preflight", async () => {
      const cancelDiscovery = vi.fn(() => Effect.void);
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        ingestRuntimeEvents: true,
        cancelClaudeCompactionDiscovery: cancelDiscovery,
      });
      await dispatchHarnessUserTurn(harness, {
        messageId: "before-native-steer",
        text: "Initial task",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId("before-native-steer-turn");
      harness.setRuntimeSessionTurnState({
        threadId: "thread-1",
        status: "running",
        activeTurnId: turnId,
      });
      await harness.emitRuntimeEvent({
        type: "turn.started",
        eventId: asEventId("native-steer-started"),
        provider: "claudeAgent",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        payload: {},
        providerRefs: {},
      });
      await waitFor(
        async () => (await readHarnessThread(harness))?.session?.activeTurnId === turnId,
      );

      const leaseAcquired = Effect.runSync(Deferred.make<void>());
      const releaseLease = Effect.runSync(Deferred.make<void>());
      const leaseFiber = Effect.runFork(
        harness.checkpointCoordinator.withThreadLease(
          threadId,
          Deferred.succeed(leaseAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLease)),
          ),
        ),
      );
      await Effect.runPromise(Deferred.await(leaseAcquired));
      try {
        const response = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-native-steer-compact"),
            threadId,
            message: {
              messageId: asMessageId("native-steer-compact"),
              role: "user",
              text: "/compact Preserve project decisions",
              attachments: [],
            },
            dispatchMode: "steer",
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(async () => {
          const delivery = await Effect.runPromise(
            harness.deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: response.sequence,
            }),
          );
          return Option.getOrUndefined(delivery)?.state === "inflight";
        });
        harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
        await harness.emitRuntimeEvent({
          type: "turn.completed",
          eventId: asEventId("native-steer-settled"),
          provider: "claudeAgent",
          createdAt: new Date().toISOString(),
          threadId,
          turnId,
          payload: { state: "completed" },
          providerRefs: {},
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-native-steer-cancel"),
            threadId,
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(() => cancelDiscovery.mock.calls.length === 1);
        await Effect.runPromise(Deferred.succeed(releaseLease, undefined));
        await harness.drain();
        expect(harness.steerTurn).not.toHaveBeenCalled();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseLease, undefined));
        await Effect.runPromise(Effect.exit(Fiber.join(leaseFiber)));
      }
    });

    it.each(["startup", "observation"] as const)(
      "cancels a compaction response during %s without waiting for preflight",
      async (phase) => {
        let releaseObservation!: () => void;
        const observationGate = new Promise<void>((resolve) => {
          releaseObservation = resolve;
        });
        const cancelDiscovery = vi.fn(() => Effect.void);
        const { harness, startClaudeCompaction, getClaudeCacheObservation } =
          await createCompactionHarness(cancelDiscovery);
        const review = await sendHeldMessage(harness);
        if (phase === "startup") {
          await Effect.runPromise(
            harness.stopRuntimeSession({ threadId: ThreadId.makeUnsafe("thread-1") }),
          );
          const startSession = harness.startSession.getMockImplementation()!;
          harness.startSession.mockImplementationOnce((...args) =>
            Effect.promise(() => observationGate).pipe(Effect.flatMap(() => startSession(...args))),
          );
        } else {
          getClaudeCacheObservation.mockImplementationOnce(() =>
            Effect.promise(() => observationGate).pipe(
              Effect.andThen(Effect.succeed(review.assessment)),
            ),
          );
        }
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-compact-before-handoff"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() =>
            phase === "startup"
              ? harness.startSession.mock.calls.length === 2
              : getClaudeCacheObservation.mock.calls.length === 2,
          );
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe("cmd-interrupt-before-handoff"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() => cancelDiscovery.mock.calls.length === 1);
          await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeout(Duration.seconds(1))));
          releaseObservation();
          await harness.drain();
          expect(startClaudeCompaction).not.toHaveBeenCalled();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
        } finally {
          releaseObservation();
        }
      },
    );

    it("cancels a cache-review compaction while a checkpoint revert holds its lease", async () => {
      const cancelDiscovery = vi.fn(() => Effect.void);
      const { harness, startClaudeCompaction } = await createCompactionHarness(cancelDiscovery);
      const review = await sendHeldMessage(harness);
      const threadId = ThreadId.makeUnsafe("thread-1");
      const leaseAcquired = Effect.runSync(Deferred.make<void>());
      const releaseLease = Effect.runSync(Deferred.make<void>());
      const leaseFiber = Effect.runFork(
        harness.checkpointCoordinator.withThreadLease(
          threadId,
          Deferred.succeed(leaseAcquired, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLease)),
          ),
        ),
      );
      await Effect.runPromise(Deferred.await(leaseAcquired));
      try {
        const response = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.respond",
            commandId: CommandId.makeUnsafe("cmd-compact-behind-checkpoint-lease"),
            threadId,
            reviewId: review.reviewId,
            messageId: review.messageId,
            decision: "compact",
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(async () => {
          const delivery = await Effect.runPromise(
            harness.deliveryRepository.getDelivery({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: response.sequence,
            }),
          );
          return Option.getOrUndefined(delivery)?.state === "inflight";
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-cancel-behind-checkpoint-lease"),
            threadId,
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(() => cancelDiscovery.mock.calls.length === 1);
        await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeout(Duration.seconds(1))));
        expect(startClaudeCompaction).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseLease, undefined));
        await Effect.runPromise(Effect.exit(Fiber.join(leaseFiber)));
      }
    });

    it("discovery error leaves the held message retryable", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      startClaudeCompaction.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: "claudeAgent",
            operation: "startClaudeCompaction",
            issue:
              "Could not discover native compaction support: Transient command discovery RPC failure",
          }),
        ),
      );
      const issueReport = vi
        .spyOn(betaOperationalIssue, "reportBetaOperationalIssue")
        .mockImplementation(() => {});
      try {
        await respondToReview(harness, review, "compact");
        expect(issueReport).toHaveBeenCalledWith({
          code: "claude.cache.failed",
          reason: "unknown",
        });
      } finally {
        issueReport.mockRestore();
      }
      const blocker = await Effect.runPromise(
        harness.deliveryRepository.firstBlockingDeliveryForThread({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          threadId: "thread-1",
        }),
      );
      expect({
        status: (await readHarnessThread(harness))?.claudeCacheReview?.status,
        blocked: Option.isSome(blocker),
      }).toEqual({ status: "failed", blocked: false });
    });
    it.each(["stop", "archive"] as const)(
      "%s preserves recovery of an uncertain compaction",
      async (cancellation) => {
        const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        startClaudeCompaction.mockImplementation(() =>
          Effect.fail(
            new ProviderSessionDirectoryPersistenceError({
              operation: "startClaudeCompaction.persist",
              detail: "Accepted but persistence failed",
              cause: new PersistenceSqlError({
                operation: "persistCompaction",
                detail: "SQL unavailable",
              }),
            }),
          ),
        );
        await respondToReview(harness, review, "compact");
        const uncertain = (await readHarnessThread(harness))?.claudeCacheReview;
        expect(uncertain?.status).toBe("uncertain");
        const turnId = uncertain!.compactionTurnId!;
        await Effect.runPromise(
          harness.engine.dispatch({
            type: cancellation === "stop" ? "thread.session.stop" : "thread.archive",
            commandId: CommandId.makeUnsafe("review-stop"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: new Date().toISOString(),
          }),
        );
        await harness.drain();
        if (cancellation === "stop") {
          setObservation({
            ...review.assessment,
            state: "likely-warm",
            contextTokens: 16_000,
            lastResponseAt: new Date().toISOString(),
          });
          await dispatchHarnessUserTurn(harness, {
            messageId: "blocked-after-stop",
            text: "Do not silently replay this blocked send",
            createdAt: new Date().toISOString(),
          });
          await harness.drain();
          expect(harness.sendTurn).not.toHaveBeenCalled();
        }
        await emitCompactionTerminal(
          harness,
          asTurnId("unrelated-late-terminal"),
          {
            state: "completed",
            contextCompacted: true,
          },
          "unrelated",
        );
        expect(
          await Effect.runPromise(
            harness.reactor.listBlockingDeliveries({
              threadId: ThreadId.makeUnsafe("thread-1"),
              limit: 10,
            }),
          ),
        ).toHaveLength(1);
        await emitCompactionTerminal(harness, turnId, {
          state: "completed",
          contextCompacted: true,
        });
        // The terminal removes the blocker before replay finishes; acquire the
        // reconciliation lock again so the assertion observes the whole operation.
        await Effect.runPromise(
          harness.reactor.reconcileDelivery({
            threadId: ThreadId.makeUnsafe("thread-1"),
            eventSequence: uncertain!.compactionResponseEventSequence!,
            expectedState: "uncertain",
            outcome: "accepted",
            reconciledBy: "test-settlement-barrier",
          }),
        );
        const blocker = await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId: "thread-1",
          }),
        );
        expect({
          stopped: harness.stopRuntimeSession.mock.calls.length,
          blocked: Option.isSome(blocker),
          review: (await readHarnessThread(harness))?.claudeCacheReview,
        }).toEqual({ stopped: 1, blocked: false, review: null });
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it("persists compacting before native dispatch and keeps the user message pending", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      startClaudeCompaction.mockImplementation(({ threadId, turnId }) =>
        Effect.gen(function* () {
          const readModel = yield* harness.engine.getReadModel();
          expect(
            readModel.threads.find((thread) => thread.id === threadId)?.claudeCacheReview,
          ).toMatchObject({
            reviewId: review.reviewId,
            status: "compacting",
            compactionTurnId: turnId,
          });
          return { threadId, turnId };
        }),
      );

      await respondToReview(harness, review, "compact");

      expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = await readHarnessThread(harness);
      expect(thread?.claudeCacheReview?.status).toBe("compacting");
      expect(
        thread?.messages.find((message) => message.id === review.messageId)?.turnId,
      ).toBeNull();
      await dispatchHarnessUserTurn(harness, {
        messageId: "cache-message-during-compaction",
        text: "Remain queued until the pending message is released",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("ignores completion from a different turn while compaction is pending", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      await respondToReview(harness, review, "compact");
      expect(startClaudeCompaction).toHaveBeenCalledTimes(1);

      await emitCompactionTerminal(harness, asTurnId("unrelated-compaction-turn"), {
        state: "completed",
        contextCompacted: true,
      });

      expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("compacting");
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it.each(["completed", "aborted"] as const)(
      "keeps the user message unsent after compaction terminal %s without a verified boundary",
      async (state) => {
        const { harness, startClaudeCompaction } = await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        await respondToReview(harness, review, "compact");
        const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
        expect(turnId).toBeTruthy();

        await emitCompactionTerminal(harness, turnId!, { state });
        await waitFor(
          async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "failed",
        );

        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.messages).toContainEqual(
          expect.objectContaining({
            id: review.messageId,
            text: "Continue with this exact message",
            turnId: null,
          }),
        );
      },
    );

    it.each(["expired", "safely-retryable"] as const)(
      "does not send a cancelled Continue when recovering a %s inflight claim",
      async (settlement) => {
        const observation = expiredCacheObservation();
        const harness = await createCacheHarness(() => observation, false);
        const threadId = ThreadId.makeUnsafe("thread-1");
        const now = new Date().toISOString();
        const { source, review } = await seedRecoveredHeldCacheSource(harness, observation, now, {
          messageId: "cancelled-recovery-message",
          reviewId: "cancelled-recovery-review",
          text: "Do not send after recovery cancellation",
          setCommandId: "cmd-recovery-review",
        });
        const response = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.respond",
            commandId: CommandId.makeUnsafe("cmd-recovery-continue"),
            threadId,
            reviewId: review.reviewId,
            messageId: review.messageId,
            decision: "continue",
            createdAt: now,
          }),
        );
        await Effect.runPromise(
          harness.deliveryRepository.claim({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: response.sequence,
            threadId,
            claimOwner: "previous-process",
            claimedAt: now,
            claimExpiresAt:
              settlement === "expired" ? now : new Date(Date.now() + 1_000).toISOString(),
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-recovery-interrupt"),
            threadId,
            createdAt: now,
          }),
        );
        const getDelivery = harness.deliveryRepository.getDelivery;
        let reads = 0;
        Object.assign(harness.deliveryRepository, {
          getDelivery: (input: Parameters<typeof getDelivery>[0]) => {
            if (input.eventSequence === response.sequence) reads++;
            return getDelivery(input);
          },
        });
        const starting = harness.startReactor();
        if (settlement === "safely-retryable") {
          await waitFor(() => reads >= 3);
          const requeued = await Effect.runPromise(
            harness.deliveryRepository.markRetryable({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: response.sequence,
              expectedClaimOwner: "previous-process",
              error: "Prior owner confirmed pre-dispatch rejection",
              updatedAt: new Date().toISOString(),
            }),
          );
          expect(requeued).toBe(true);
        }
        await starting;
        await harness.drain();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        const delivery = await Effect.runPromise(
          getDelivery({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: response.sequence,
          }),
        );
        expect(delivery.pipe(Option.getOrThrow).state).toBe(
          settlement === "expired" ? "uncertain" : "succeeded",
        );
      },
    );

    it("fences a Continue interrupted before cache worker registration", async () => {
      const cancelDiscovery = vi.fn(() => Effect.void);
      const { harness } = await createCompactionHarness(cancelDiscovery);
      const review = await sendHeldMessage(harness);
      const sequence = (await Effect.runPromise(harness.engine.getEventHighWaterSequence)) + 2;
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const readDelivery = harness.deliveryRepository.getDelivery;
      let gated = false;
      Object.assign(harness.deliveryRepository, {
        getDelivery: (input: Parameters<typeof readDelivery>[0]) => {
          if (input.eventSequence !== sequence || gated) return readDelivery(input);
          gated = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(readDelivery(input)),
          );
        },
      });
      try {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.respond",
            commandId: CommandId.makeUnsafe("cmd-gap-continue"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            reviewId: review.reviewId,
            messageId: review.messageId,
            decision: "continue",
            createdAt: new Date().toISOString(),
          }),
        );
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-gap-interrupt"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: new Date().toISOString(),
          }),
        );
        await waitFor(() => cancelDiscovery.mock.calls.length === 1);
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
      }
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it.each(["model", "runtime", "handoff"] as const)(
      "preserves the session during same-thread %s reconfiguration with a cache worker",
      async (change) => {
        const { harness, getClaudeCacheObservation, startClaudeCompaction } =
          await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        const releaseObservation = Deferred.makeUnsafe<void>();
        getClaudeCacheObservation.mockImplementationOnce(() =>
          Deferred.await(releaseObservation).pipe(Effect.as(review.assessment)),
        );
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-reconfigure-compact"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() => getClaudeCacheObservation.mock.calls.length === 2);
          const update = await Effect.runPromise(
            harness.engine.dispatch(
              change !== "runtime"
                ? {
                    type: "thread.meta.update",
                    commandId: CommandId.makeUnsafe("cmd-change-provider-during-compaction"),
                    threadId: ThreadId.makeUnsafe("thread-1"),
                    modelSelection: { provider: "codex", model: "gpt-5-codex" },
                    ...(change === "handoff" ? { providerHandoff: true } : {}),
                  }
                : {
                    type: "thread.runtime-mode.set",
                    commandId: CommandId.makeUnsafe("cmd-change-runtime-during-compaction"),
                    threadId: ThreadId.makeUnsafe("thread-1"),
                    runtimeMode: "full-access",
                    createdAt: new Date().toISOString(),
                  },
            ),
          );
          await waitFor(async () => {
            const state = await Effect.runPromise(
              harness.deliveryRepository.getConsumerState(PROVIDER_COMMAND_REACTOR_CONSUMER),
            );
            return state.pipe(Option.getOrThrow).lastAckedSequence >= update.sequence;
          });
          expect(harness.startSession).toHaveBeenCalledTimes(1);
          expect(harness.stopSession).not.toHaveBeenCalled();
          if (change === "handoff") {
            expect((await readHarnessThread(harness))?.activities).toContainEqual(
              expect.objectContaining({ kind: "provider.handoff.failed" }),
            );
          }
        } finally {
          await Effect.runPromise(Deferred.succeed(releaseObservation, undefined));
        }
        await harness.drain();
        expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
      },
    );

    it("settles a hung cache response under its finite deadline", async () => {
      let cleanedUp = false;
      const release = Deferred.makeUnsafe<void>();
      const observation = expiredCacheObservation();
      const startClaudeCompaction = vi.fn<
        NonNullable<ProviderServiceShape["startClaudeCompaction"]>
      >((input) =>
        Deferred.await(release).pipe(
          Effect.as(input),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              cleanedUp = true;
            }),
          ),
        ),
      );
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation: () => Effect.succeed(observation),
        startClaudeCompaction,
        cacheResponseTimeout: Duration.millis(100),
      });
      const review = await sendHeldMessage(harness);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.respond",
          commandId: CommandId.makeUnsafe("cmd-cache-response-deadline"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          reviewId: review.reviewId,
          messageId: review.messageId,
          decision: "compact",
          createdAt: new Date().toISOString(),
        }),
      );
      try {
        await waitFor(() => startClaudeCompaction.mock.calls.length === 1, 500);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(cleanedUp).toBe(true);
        await waitFor(async () =>
          (
            await Effect.runPromise(
              harness.reactor.listBlockingDeliveries({
                threadId: ThreadId.makeUnsafe("thread-1"),
                limit: 10,
              }),
            )
          ).some((delivery) => delivery.state === "uncertain"),
        );
        const blockers = await Effect.runPromise(
          harness.reactor.listBlockingDeliveries({
            threadId: ThreadId.makeUnsafe("thread-1"),
            limit: 10,
          }),
        );
        expect(blockers).toContainEqual(expect.objectContaining({ state: "uncertain" }));
        expect(harness.sendTurn).not.toHaveBeenCalled();
        const settledReview = (await readHarnessThread(harness))?.claudeCacheReview;
        expect(settledReview?.status).toBe("uncertain");
        expect(settledReview?.error).toContain("did not respond within 100ms");
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
      }
    });

    it("keeps an operator retried slow cache response alive beyond the command deadline", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness(
        undefined,
        false,
        Duration.millis(100),
      );
      const review = await sendHeldMessage(harness);
      startClaudeCompaction.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderSessionDirectoryPersistenceError({
            operation: "startClaudeCompaction.persist",
            detail: "Accepted but persistence failed",
            cause: new PersistenceSqlError({
              operation: "persistCompaction",
              detail: "SQL unavailable",
            }),
          }),
        ),
      );
      await respondToReview(harness, review, "compact");
      const uncertain = (await readHarnessThread(harness))!.claudeCacheReview!;
      const release = Deferred.makeUnsafe<void>();
      startClaudeCompaction.mockImplementation((input) =>
        Deferred.await(release).pipe(Effect.as(input)),
      );
      const retry = Effect.runPromise(
        harness.reactor.reconcileDelivery({
          threadId: ThreadId.makeUnsafe("thread-1"),
          eventSequence: uncertain.compactionResponseEventSequence!,
          expectedState: "uncertain",
          outcome: "safe_retry",
          reconciledBy: "operator-confirmed-never-executed",
        }),
      );
      try {
        await waitFor(() => startClaudeCompaction.mock.calls.length === 2);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("compacting");
        const threadId = ThreadId.makeUnsafe("thread-during-retried-compaction");
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-create-during-retried-compaction"),
            threadId,
            projectId: asProjectId("project-1"),
            title: "Independent chat",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          }),
        );
        await dispatchHarnessUserTurn(harness, {
          threadId,
          messageId: "during-retried-compaction",
          text: "Work during the operator retry",
          createdAt: new Date().toISOString(),
        });
        await waitFor(() =>
          harness.sendTurn.mock.calls.some(([input]) => input.threadId === threadId),
        );
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await retry;
      }
      await harness.drain();
    });

    it.each(["compaction", "follow-up", "cancel-follow-up"] as const)(
      "keeps slow %s alive beyond the command deadline while another chat sends",
      async (phase) => {
        const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness(
          undefined,
          false,
          Duration.millis(100),
        );
        const review = await sendHeldMessage(harness);
        const releaseDispatch = Deferred.makeUnsafe<void>();
        if (phase === "compaction") {
          startClaudeCompaction.mockImplementation(({ threadId, turnId }) =>
            Deferred.await(releaseDispatch).pipe(Effect.as({ threadId, turnId })),
          );
        } else {
          harness.sendTurn.mockImplementationOnce(({ threadId }) =>
            Deferred.await(releaseDispatch).pipe(
              Effect.as({ threadId, turnId: asTurnId("after-compaction") }),
            ),
          );
        }
        let terminal: Promise<void> | undefined;
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-slow-compact"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() => startClaudeCompaction.mock.calls.length === 1);
          if (phase !== "compaction") {
            await harness.drain();
            setObservation({ ...review.assessment, contextTokens: 16_000, state: "likely-warm" });
            terminal = emitCompactionTerminal(
              harness,
              startClaudeCompaction.mock.calls[0]![0].turnId,
              {
                state: "completed",
                contextCompacted: true,
              },
            );
            await waitFor(() => harness.sendTurn.mock.calls.length === 1);
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          const expectedStatus = phase === "compaction" ? "compacting" : "responding";
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe(
            expectedStatus,
          );
          const threadId = ThreadId.makeUnsafe("thread-during-compaction");
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe("cmd-create-during-compaction"),
              threadId,
              projectId: asProjectId("project-1"),
              title: "Independent chat",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            }),
          );
          await dispatchHarnessUserTurn(harness, {
            threadId,
            messageId: "during-compaction",
            text: "Work while Claude compacts",
            createdAt: new Date().toISOString(),
          });
          await waitFor(() =>
            harness.sendTurn.mock.calls.some(([input]) => input.threadId === threadId),
          );
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe(
            expectedStatus,
          );
          if (phase === "cancel-follow-up") {
            await Effect.runPromise(
              harness.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.makeUnsafe("cmd-stop-pending-cache-send"),
                threadId: ThreadId.makeUnsafe("thread-1"),
                createdAt: new Date().toISOString(),
              }),
            );
            await waitFor(() => harness.stopRuntimeSession.mock.calls.length === 1);
            await Effect.runPromise(
              harness.reactor.drain.pipe(Effect.timeout(Duration.seconds(1))),
            );
            expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
            expect((await readHarnessThread(harness))?.session?.status).toBe("stopped");
          }
        } finally {
          await Effect.runPromise(Deferred.succeed(releaseDispatch, undefined));
          await terminal;
        }
        await harness.drain();
        if (phase === "compaction") {
          setObservation({ ...review.assessment, contextTokens: 16_000, state: "likely-warm" });
          await emitCompactionTerminal(harness, startClaudeCompaction.mock.calls[0]![0].turnId, {
            state: "completed",
            contextCompacted: true,
          });
        }
        await waitFor(() => harness.sendTurn.mock.calls.length === 2);
        await harness.drain();
        const savedSends = harness.sendTurn.mock.calls.filter(
          ([input]) => input.threadId === "thread-1",
        );
        expect(savedSends).toHaveLength(1);
        expect(savedSends[0]?.[0].input).toBe("Continue with this exact message");
        expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
      },
    );

    it("does not release a failed compaction even when a native boundary was observed", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      await respondToReview(harness, review, "compact");
      const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
      expect(turnId).toBeTruthy();

      await emitCompactionTerminal(harness, turnId!, { state: "failed", contextCompacted: true });
      await waitFor(
        async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "failed",
      );

      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("releases the saved message exactly once after verified compaction, even when the remaining large context is expired", async () => {
      const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      await respondToReview(harness, review, "compact");
      const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
      expect(turnId).toBeTruthy();
      setObservation({
        ...review.assessment,
        contextTokens: 110_000,
        state: "likely-expired",
        lastResponseAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
      });

      await emitCompactionTerminal(harness, turnId!, {
        state: "completed",
        contextCompacted: true,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("Continue with this exact message");
      expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
      expect(
        (await readHarnessThread(harness))?.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect((await readHarnessThread(harness))?.messages[0]?.turnId).not.toBe(turnId);
      await emitCompactionTerminal(
        harness,
        turnId!,
        { state: "completed", contextCompacted: true },
        "large-expired-duplicate",
      );
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
    });

    it.each(["nativeSessionId", "lifecycleGeneration", "model"] as const)(
      "does not reuse verified compaction consent after %s changes",
      async (field) => {
        const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        await respondToReview(harness, review, "compact");
        const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
        expect(turnId).toBeTruthy();
        setObservation({
          ...review.assessment,
          [field]: `${review.assessment[field]}-changed`,
          contextTokens: 110_000,
          state: "likely-expired",
          lastResponseAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
          observedAt: new Date().toISOString(),
        });

        await emitCompactionTerminal(harness, turnId!, {
          state: "completed",
          contextCompacted: true,
        });
        await waitFor(
          async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "pending",
        );
        await harness.drain();

        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
          messageId: review.messageId,
          assessment: { [field]: `${review.assessment[field]}-changed` },
        });
      },
    );

    it("requires another review when context grows beyond the consented size after compaction", async () => {
      const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      await respondToReview(harness, review, "compact");
      const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
      expect(turnId).toBeTruthy();
      setObservation({
        ...review.assessment,
        contextTokens: 150_000,
        state: "likely-expired",
        lastResponseAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
        observedAt: new Date().toISOString(),
      });

      await emitCompactionTerminal(harness, turnId!, {
        state: "completed",
        contextCompacted: true,
      });
      await waitFor(
        async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "pending",
      );
      await harness.drain();

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview?.assessment.contextTokens).toBe(
        150_000,
      );
    });

    it("surfaces a real invariant failure while releasing a verified compaction", async () => {
      const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      await respondToReview(harness, review, "compact");
      const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
      expect(turnId).toBeTruthy();
      setObservation({
        ...review.assessment,
        contextTokens: 16_000,
        state: "likely-warm",
        lastResponseAt: new Date().toISOString(),
      });
      let rejectedCommands = 0;
      harness.interceptEngineDispatch((command) => {
        if (command.type !== "thread.claude-cache.compacted") return undefined;
        rejectedCommands += 1;
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Simulated compaction release invariant violation.",
          }),
        );
      });

      await emitCompactionTerminal(harness, turnId!, {
        state: "completed",
        contextCompacted: true,
      });
      await waitFor(
        async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "failed",
      );
      await harness.drain();

      expect(rejectedCommands).toBe(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview?.error).toContain(
        "Simulated compaction release invariant violation.",
      );
    });

    it.each(["accepted", "persistence-failure"] as const)(
      "waits for compaction dispatch settlement before releasing an early terminal (%s)",
      async (settlement) => {
        const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        let terminalPublished = false;
        let releaseDispatch!: () => void;
        const dispatchGate = new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        startClaudeCompaction.mockImplementation(({ threadId, turnId }) =>
          Effect.gen(function* () {
            setObservation({
              ...review.assessment,
              contextTokens: 16_000,
              state: "likely-warm",
              lastResponseAt: new Date().toISOString(),
            });
            const terminal: ProviderRuntimeEvent = {
              eventId: asEventId("evt-early-compaction-terminal"),
              provider: "claudeAgent",
              threadId,
              turnId,
              createdAt: new Date().toISOString(),
              providerRefs: {},
              type: "turn.completed",
              payload: { state: "completed", contextCompacted: true },
            };
            const persisted = yield* harness.runtimeEventRepository.append(terminal);
            yield* harness.runtimeEventRepository.advanceConsumerCursor({
              consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
              eventSequence: persisted.sequence,
              updatedAt: terminal.createdAt,
            });
            yield* Effect.promise(() => harness.emitRuntimeEvent(terminal));
            terminalPublished = true;
            yield* Effect.promise(() => dispatchGate);
            if (settlement === "persistence-failure") {
              return yield* new ProviderSessionDirectoryPersistenceError({
                operation: "startClaudeCompaction.persist",
                detail: "Injected persistence failure after native completion",
                cause: new PersistenceSqlError({
                  operation: "persistCompaction",
                  detail: "Injected SQL failure",
                }),
              });
            }
            return { threadId, turnId };
          }),
        );
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-early-terminal-compact"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() => terminalPublished);
          // Give the independent runtime-event consumer a turn while the
          // source delivery is deliberately still awaiting provider acceptance.
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("compacting");
          expect(harness.sendTurn).not.toHaveBeenCalled();
        } finally {
          releaseDispatch();
        }

        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await harness.drain();

        expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("Continue with this exact message");
        expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
        const blocker = await Effect.runPromise(
          harness.deliveryRepository.firstBlockingDeliveryForThread({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            threadId: "thread-1",
          }),
        );
        expect(Option.isNone(blocker)).toBe(true);
      },
    );

    it.each(["active", "cancelled"] as const)(
      "settles a failed ingestion release without retrying native compaction (%s)",
      async (consent) => {
        const { harness, startClaudeCompaction } = await createCompactionHarness();
        const review = await sendHeldMessage(harness);
        await respondToReview(harness, review, "compact");
        const turnId = startClaudeCompaction.mock.calls[0]![0].turnId;
        harness.setRuntimeSessionTurnState({ threadId: "thread-1", status: "ready" });
        const terminal: ProviderRuntimeEvent = {
          eventId: asEventId("terminal-waiter-release-failure"),
          provider: "claudeAgent",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId,
          createdAt: new Date().toISOString(),
          providerRefs: {},
          type: "turn.completed",
          payload: { state: "completed", contextCompacted: true },
        };
        const persisted = await Effect.runPromise(harness.runtimeEventRepository.append(terminal));
        let releaseAttempts = 0;
        harness.interceptEngineDispatch((command) => {
          if (command.type !== "thread.claude-cache.compacted") return undefined;
          releaseAttempts++;
          return Effect.gen(function* () {
            if (consent === "cancelled")
              yield* harness.engine.dispatch({
                type: "thread.session.stop",
                commandId: CommandId.makeUnsafe("stop-during-release-failure"),
                threadId: ThreadId.makeUnsafe("thread-1"),
                createdAt: new Date().toISOString(),
              });
            return yield* new OrchestrationCommandInternalError({
              commandId: command.commandId,
              commandType: command.type,
              detail: "Injected release persistence error",
            });
          });
        });
        await harness.emitRuntimeEvent(terminal);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(releaseAttempts).toBe(0);
        await Effect.runPromise(
          harness.runtimeEventRepository.advanceConsumerCursor({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            eventSequence: persisted.sequence,
            updatedAt: terminal.createdAt,
          }),
        );
        await waitFor(() => releaseAttempts === 1);
        await waitFor(async () =>
          consent === "cancelled"
            ? (await readHarnessThread(harness))?.claudeCacheReview === null
            : (await readHarnessThread(harness))?.claudeCacheReview?.status === "failed",
        );
        expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (consent === "active")
          expect((await readHarnessThread(harness))?.claudeCacheReview?.messageId).toBe(
            review.messageId,
          );
      },
    );

    it("renews the cache review instead of compacting a changed session", async () => {
      const { harness, startClaudeCompaction, setObservation } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      setObservation({ ...review.assessment, nativeSessionId: "different-native-session" });

      await respondToReview(harness, review, "compact");

      expect(startClaudeCompaction).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
        status: "pending",
        assessment: { nativeSessionId: "different-native-session" },
      });
    });

    it("rejects compaction while native background tasks are still active", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      const review = await sendHeldMessage(harness);
      harness.hasLiveRuntimeTasks.mockImplementation(() => Effect.succeed(true));

      await respondToReview(harness, review, "compact");

      expect(startClaudeCompaction).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
    });

    it("sends /compact without asking, like Claude Code", async () => {
      const { harness, startClaudeCompaction } = await createCompactionHarness();
      await dispatchHarnessUserTurn(harness, {
        messageId: "cache-direct-compact",
        text: "/compact Preserve the pending task",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("/compact Preserve the pending task");
      expect((await readHarnessThread(harness))?.claudeCacheReview ?? null).toBeNull();
      expect(startClaudeCompaction).not.toHaveBeenCalled();
    });

    it("does not compact before a held review whose original message already requests /compact", async () => {
      // Reviews like this were persisted before /compact stopped being held.
      const observation = expiredCacheObservation();
      const startClaudeCompaction = vi.fn<
        NonNullable<ProviderServiceShape["startClaudeCompaction"]>
      >(({ threadId, turnId }) => Effect.succeed({ threadId, turnId }));
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation: () => Effect.succeed(observation),
        startClaudeCompaction,
        startReactor: false,
      });
      const now = new Date().toISOString();
      const source = await dispatchHarnessUserTurn(harness, {
        messageId: "cache-original-compact",
        text: "/compact Preserve the pending task",
        createdAt: now,
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe("cmd-cache-original-compact-review"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          review: {
            reviewId: "cache-original-compact-review",
            messageId: asMessageId("cache-original-compact"),
            sourceEventSequence: source.sequence,
            assessment: observation,
            status: "pending",
            createdAt: now,
          },
          expectedReviewId: null,
          createdAt: now,
        }),
      );
      await harness.startReactor();
      await harness.drain();
      const review = (await readHarnessThread(harness))?.claudeCacheReview;
      expect(review?.status).toBe("pending");

      await respondToReview(harness, review, "compact");

      expect(startClaudeCompaction).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
    });

    it.each(["cache-revalidation", "persisted-compacting"] as const)(
      "fails a compact request when rollback removes its message during %s",
      async (stage) => {
        const observation = expiredCacheObservation();
        let getterCalls = 0;
        let releaseObservation!: (observation: ClaudeCacheObservation) => void;
        const observationGate = new Promise<ClaudeCacheObservation>((resolve) => {
          releaseObservation = resolve;
        });
        const startClaudeCompaction = vi.fn<
          NonNullable<ProviderServiceShape["startClaudeCompaction"]>
        >((input) => Effect.succeed(input));
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
          startClaudeCompaction,
          getClaudeCacheObservation: () => {
            getterCalls += 1;
            return stage === "cache-revalidation" && getterCalls === 2
              ? Effect.promise(() => observationGate)
              : Effect.succeed(observation);
          },
        });
        const review = await sendHeldMessage(harness);
        const rollback: OrchestrationCommand = {
          type: "thread.conversation.rollback.complete",
          commandId: CommandId.makeUnsafe("cmd-compact-authorization-rollback"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: review.messageId,
          numTurns: 1,
          createdAt: new Date().toISOString(),
        };
        let sawPersistedCompacting = false;
        if (stage === "persisted-compacting") {
          const dispatch = harness.engine.dispatch;
          harness.interceptEngineDispatch((command) => {
            if (
              command.type !== "thread.claude-cache.set" ||
              command.review?.status !== "compacting"
            )
              return undefined;
            return Effect.gen(function* () {
              const receipt = yield* dispatch(command);
              const thread = (yield* harness.engine.getReadModel()).threads.find(
                (candidate) => candidate.id === rollback.threadId,
              );
              expect(thread?.claudeCacheReview?.status).toBe("compacting");
              sawPersistedCompacting = true;
              yield* dispatch(rollback);
              return receipt;
            });
          });
        }
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-compact-authorization-respond"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "compact",
              createdAt: new Date().toISOString(),
            }),
          );
          if (stage === "cache-revalidation") {
            await waitFor(() => getterCalls === 2);
            await Effect.runPromise(harness.engine.dispatch(rollback));
          }
        } finally {
          releaseObservation(observation);
        }
        await harness.drain();

        if (stage === "persisted-compacting") expect(sawPersistedCompacting).toBe(true);
        expect(startClaudeCompaction).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.messages).toEqual([]);
        expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
      },
    );

    it.each(["archive", "stop", "rollback"] as const)(
      "revokes an accepted Continue when %s arrives during cache revalidation",
      async (action) => {
        const observation = expiredCacheObservation();
        let getterCalls = 0;
        let releaseObservation!: (observation: ClaudeCacheObservation) => void;
        const observationGate = new Promise<ClaudeCacheObservation>((resolve) => {
          releaseObservation = resolve;
        });
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
          getClaudeCacheObservation: () => {
            getterCalls += 1;
            return getterCalls === 2
              ? Effect.promise(() => observationGate)
              : Effect.succeed(observation);
          },
        });
        const review = await sendHeldMessage(harness);
        try {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-cache-continue-during-revalidation"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "continue",
              createdAt: new Date().toISOString(),
            }),
          );
          await waitFor(() => getterCalls === 2);
          await Effect.runPromise(
            harness.engine.dispatch(
              action === "archive"
                ? {
                    type: "thread.archive",
                    commandId: CommandId.makeUnsafe("cmd-cache-archive-during-revalidation"),
                    threadId: ThreadId.makeUnsafe("thread-1"),
                  }
                : action === "stop"
                  ? {
                      type: "thread.session.stop",
                      commandId: CommandId.makeUnsafe("cmd-cache-stop-during-revalidation"),
                      threadId: ThreadId.makeUnsafe("thread-1"),
                      createdAt: new Date().toISOString(),
                    }
                  : {
                      type: "thread.conversation.rollback.complete",
                      commandId: CommandId.makeUnsafe("cmd-cache-rollback-during-revalidation"),
                      threadId: ThreadId.makeUnsafe("thread-1"),
                      messageId: review.messageId,
                      numTurns: 1,
                      createdAt: new Date().toISOString(),
                    },
            ),
          );
        } finally {
          releaseObservation(observation);
        }
        await harness.drain();

        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await readHarnessThread(harness))?.claudeCacheReview?.status).not.toBe(
          "responding",
        );
        if (action === "rollback") {
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
          expect((await readHarnessThread(harness))?.messages).toEqual([]);
        }
      },
    );

    it.each([
      "running",
      "settled-before-publication",
      "cancelled-stop",
      "cancelled-interrupt",
      "cancelled-archive",
      "cancelled-delete",
      "cancelled-rollback",
    ] as const)("replays compaction choices with ordered cancellation (%s)", async (settlement) => {
      let observation = expiredCacheObservation();
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-1");
      const startClaudeCompaction = vi.fn<
        NonNullable<ProviderServiceShape["startClaudeCompaction"]>
      >((input) => Effect.succeed(input));
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        startReactor: false,
        startClaudeCompaction,
        getClaudeCacheObservation: () => Effect.sync(() => observation),
      });
      startClaudeCompaction.mockImplementation((input) =>
        Effect.sync(() => {
          harness.setRuntimeSessionTurnState({
            threadId: input.threadId,
            status: settlement === "running" ? "running" : "ready",
            ...(settlement === "running" ? { activeTurnId: input.turnId } : {}),
          });
          return input;
        }),
      );
      if (settlement === "cancelled-rollback") {
        await seedRollbackTarget(harness, {
          messageId: asMessageId("before-replay-history"),
          turnId: asTurnId("before-replay-turn"),
          createdAt: now,
        });
      }
      const source = await dispatchHarnessUserTurn(harness, {
        messageId: "startup-replay-user",
        text: "Continue after this live compaction",
        createdAt: now,
      });
      const review = {
        reviewId: "startup-replay-review",
        messageId: asMessageId("startup-replay-user"),
        sourceEventSequence: source.sequence,
        assessment: observation,
        status: "pending" as const,
        createdAt: now,
      };
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe("cmd-startup-replay-review"),
          threadId,
          review,
          expectedReviewId: null,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.claim({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          threadId,
          claimOwner: "previous-process",
          claimedAt: now,
          claimExpiresAt: now,
        }),
      );
      await Effect.runPromise(
        harness.deliveryRepository.complete({
          consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
          eventSequence: source.sequence,
          claimOwner: "previous-process",
          completedAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.claude-cache.respond",
          commandId: CommandId.makeUnsafe("cmd-startup-replay-compact"),
          threadId,
          reviewId: review.reviewId,
          messageId: review.messageId,
          decision: "compact",
          createdAt: now,
        }),
      );

      if (settlement.startsWith("cancelled-")) {
        if (settlement === "cancelled-rollback") {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.conversation.rollback",
              commandId: CommandId.makeUnsafe("cmd-cancel-before-replay"),
              threadId,
              messageId: asMessageId("before-replay-history"),
              numTurns: 1,
              createdAt: now,
            }),
          );
        } else {
          const commandType =
            settlement === "cancelled-stop"
              ? "thread.session.stop"
              : settlement === "cancelled-interrupt"
                ? "thread.turn.interrupt"
                : settlement === "cancelled-archive"
                  ? "thread.archive"
                  : "thread.delete";
          await Effect.runPromise(
            harness.engine.dispatch({
              type: commandType,
              commandId: CommandId.makeUnsafe("cmd-cancel-before-replay"),
              threadId,
              createdAt: now,
            }),
          );
        }
      }

      await harness.startReactor();
      await harness.drain();

      if (settlement.startsWith("cancelled-")) {
        expect(startClaudeCompaction).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (settlement === "cancelled-interrupt") {
          expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
          await dispatchHarnessUserTurn(harness, {
            messageId: "retry-after-interrupt-message",
            text: "Compact for this new choice",
            createdAt: new Date().toISOString(),
          });
          await waitFor(
            async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "pending",
          );
          const retryReview = (await readHarnessThread(harness))?.claudeCacheReview;
          await respondToReview(harness, retryReview, "compact", "retry-after-interrupt");
          expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
        }
        return;
      }

      expect(startClaudeCompaction).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const turnId = startClaudeCompaction.mock.calls[0]?.[0].turnId;
      expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
        status: "compacting",
        compactionTurnId: turnId,
      });
      observation = {
        ...observation,
        contextTokens: 16_000,
        state: "likely-warm",
        lastResponseAt: new Date().toISOString(),
      };
      await emitCompactionTerminal(harness, turnId!, {
        state: "completed",
        contextCompacted: true,
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe("Continue after this live compaction");
      expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
    });

    it.each([
      "confirmed",
      "confirmed-after-reconciliation",
      "confirmed-inflight-behind-cursor",
      "inflight-behind-cursor",
      "cancelled-confirmed",
      "cancelled-missing",
      "confirmed-unacknowledged",
      "confirmed-invariant-failure",
      "confirmed-infrastructure-defect",
      "confirmed-recovery-interrupted",
      "uncertain-missing",
      "failed-recovery-interrupted",
      "uncertain-user-delivery",
      "inflight-user-delivery",
      "missing",
      "failed",
    ] as const)(
      "recovers %s compaction journal evidence without repeating native compaction",
      async (evidence) => {
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const turnId = asTurnId("persisted-native-compaction-turn");
        const startClaudeCompaction = vi.fn<
          NonNullable<ProviderServiceShape["startClaudeCompaction"]>
        >((input) => Effect.succeed(input));
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
          startReactor: false,
          startClaudeCompaction,
          getClaudeCacheObservation: () =>
            Effect.succeed({
              ...expiredCacheObservation(),
              contextTokens: 16_000,
              state: "likely-warm",
              lastResponseAt: now,
            }),
        });
        const source = await dispatchHarnessUserTurn(harness, {
          messageId: "persisted-compaction-user",
          text: "Resume the saved original message",
          createdAt: now,
        });
        const review = {
          reviewId: "persisted-compaction-review",
          messageId: asMessageId("persisted-compaction-user"),
          sourceEventSequence: source.sequence,
          assessment: expiredCacheObservation(),
          status: "pending" as const,
          createdAt: now,
        };
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.set",
            commandId: CommandId.makeUnsafe("cmd-seed-compaction-review"),
            threadId,
            review,
            expectedReviewId: null,
            createdAt: now,
          }),
        );
        const compactResponse = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.respond",
            commandId: CommandId.makeUnsafe("cmd-seed-compact-response"),
            threadId,
            reviewId: review.reviewId,
            messageId: review.messageId,
            decision: "compact",
            createdAt: now,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.set",
            commandId: CommandId.makeUnsafe("cmd-seed-compacting"),
            threadId,
            review: {
              ...review,
              status:
                evidence === "failed-recovery-interrupted"
                  ? "failed"
                  : evidence === "confirmed-after-reconciliation" ||
                      evidence === "uncertain-missing" ||
                      evidence.startsWith("cancelled-")
                    ? "uncertain"
                    : "compacting",
              compactionTurnId: turnId,
              compactionResponseEventSequence: compactResponse.sequence,
            },
            expectedReviewId: review.reviewId,
            createdAt: now,
          }),
        );
        for (const eventSequence of [source.sequence, compactResponse.sequence]) {
          await Effect.runPromise(
            harness.deliveryRepository.claim({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence,
              threadId,
              claimOwner: "previous-process",
              claimedAt: now,
              claimExpiresAt: now,
            }),
          );
          if (
            evidence.endsWith("inflight-behind-cursor") &&
            eventSequence === compactResponse.sequence
          ) {
            const events = await Effect.runPromise(
              Stream.runCollect(harness.engine.readEventsThrough(0, compactResponse.sequence)),
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
            continue;
          }
          await Effect.runPromise(
            (evidence === "uncertain-missing" ||
              evidence === "failed-recovery-interrupted" ||
              evidence.startsWith("cancelled-")) &&
              eventSequence === compactResponse.sequence
              ? harness.deliveryRepository.markTerminalFailure({
                  consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                  eventSequence,
                  expectedClaimOwner: "previous-process",
                  state: "uncertain",
                  error: "Lost native compaction acknowledgement",
                  updatedAt: now,
                })
              : harness.deliveryRepository.complete({
                  consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                  eventSequence,
                  claimOwner: "previous-process",
                  completedAt: now,
                }),
          );
        }
        let uncertainUserDeliverySequence: number | undefined;
        if (evidence === "uncertain-user-delivery" || evidence === "inflight-user-delivery") {
          // A confirmed compaction may have released the user's message before
          // its acknowledgement was lost and the old terminal was pruned.
          const continued = await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.compacted",
              commandId: CommandId.makeUnsafe("cmd-previous-compact-release"),
              threadId,
              reviewId: review.reviewId,
              turnId,
              createdAt: now,
            }),
          );
          uncertainUserDeliverySequence = continued.sequence;
          await Effect.runPromise(
            harness.deliveryRepository.claim({
              consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
              eventSequence: continued.sequence,
              threadId,
              claimOwner: "previous-process",
              claimedAt: now,
              claimExpiresAt: now,
            }),
          );
          if (evidence === "uncertain-user-delivery")
            await Effect.runPromise(
              harness.deliveryRepository.markTerminalFailure({
                consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
                eventSequence: continued.sequence,
                expectedClaimOwner: "previous-process",
                state: "uncertain",
                error: "Lost user message acknowledgement",
                updatedAt: now,
              }),
            );
          if (evidence === "inflight-user-delivery") {
            const events = await Effect.runPromise(
              Stream.runCollect(harness.engine.readEventsThrough(0, continued.sequence)),
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
          }
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.set",
              commandId: CommandId.makeUnsafe("cmd-uncertain-user-delivery"),
              threadId,
              review: {
                ...review,
                status: "uncertain",
                compactionTurnId: turnId,
                compactionResponseEventSequence: compactResponse.sequence,
              },
              expectedReviewId: review.reviewId,
              createdAt: now,
            }),
          );
        }
        let terminalSequence: number | undefined;
        if (
          evidence !== "missing" &&
          evidence !== "cancelled-missing" &&
          evidence !== "uncertain-missing" &&
          evidence !== "inflight-behind-cursor" &&
          evidence !== "failed-recovery-interrupted" &&
          evidence !== "uncertain-user-delivery" &&
          evidence !== "inflight-user-delivery"
        ) {
          const terminal = await Effect.runPromise(
            harness.runtimeEventRepository.append({
              eventId: asEventId("journal-cache-compaction-terminal"),
              provider: "claudeAgent",
              threadId,
              createdAt: now,
              turnId,
              providerRefs: {},
              type: "turn.completed",
              payload: {
                state: evidence === "failed" ? "failed" : "completed",
                contextCompacted: true,
              },
            } as ProviderRuntimeEvent),
          );
          terminalSequence = terminal.sequence;
          if (evidence !== "confirmed-unacknowledged") {
            await Effect.runPromise(
              harness.runtimeEventRepository.advanceConsumerCursor({
                consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
                eventSequence: terminal.sequence,
                updatedAt: now,
              }),
            );
          }
        }

        if (evidence === "confirmed-invariant-failure") {
          const nextThreadId = ThreadId.makeUnsafe("thread-2");
          const nextTurnId = asTurnId("next-native-compaction-turn");
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe("cmd-next-cache-thread"),
              threadId: nextThreadId,
              projectId: asProjectId("project-1"),
              title: "Next recovered task",
              modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: null,
              createdAt: now,
            }),
          );
          const nextSource = await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe("cmd-next-cache-message"),
              threadId: nextThreadId,
              message: {
                messageId: asMessageId("next-cache-message"),
                role: "user",
                text: "Continue the unaffected task",
                attachments: [],
              },
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: now,
            }),
          );
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.set",
              commandId: CommandId.makeUnsafe("cmd-next-cache-review"),
              threadId: nextThreadId,
              review: {
                ...review,
                reviewId: "next-cache-review",
                messageId: asMessageId("next-cache-message"),
                sourceEventSequence: nextSource.sequence,
                status: "compacting",
                compactionTurnId: nextTurnId,
              },
              expectedReviewId: null,
              createdAt: now,
            }),
          );
          const nextTerminal = await Effect.runPromise(
            harness.runtimeEventRepository.append({
              eventId: asEventId("next-cache-terminal"),
              provider: "claudeAgent",
              threadId: nextThreadId,
              createdAt: now,
              turnId: nextTurnId,
              providerRefs: {},
              type: "turn.completed",
              payload: { state: "completed", contextCompacted: true },
            } as ProviderRuntimeEvent),
          );
          await Effect.runPromise(
            harness.runtimeEventRepository.advanceConsumerCursor({
              consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
              eventSequence: nextTerminal.sequence,
              updatedAt: now,
            }),
          );
        }
        if (
          evidence.startsWith("confirmed-") &&
          [
            "confirmed-invariant-failure",
            "confirmed-infrastructure-defect",
            "confirmed-recovery-interrupted",
          ].includes(evidence)
        ) {
          harness.interceptEngineDispatch((command) => {
            if (command.type !== "thread.claude-cache.compacted" || command.threadId !== threadId)
              return undefined;
            if (evidence === "confirmed-infrastructure-defect")
              return Effect.die(new Error("Simulated recovery infrastructure defect"));
            if (evidence === "confirmed-recovery-interrupted") return Effect.interrupt;
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Simulated per-thread recovery invariant failure",
              }),
            );
          });
        }
        if (
          evidence === "confirmed-infrastructure-defect" ||
          evidence === "confirmed-recovery-interrupted"
        ) {
          await expect(harness.startReactor()).rejects.toThrow();
          expect(harness.sendTurn).not.toHaveBeenCalled();
          return;
        }
        if (evidence.startsWith("cancelled-")) {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.makeUnsafe("cancel-before-recovery"),
              threadId,
              createdAt: now,
            }),
          );
          await dispatchHarnessUserTurn(harness, {
            messageId: "blocked-before-startup-recovery",
            text: "Do not replay this blocked send at startup",
            createdAt: now,
          });
        }
        await harness.startReactor();
        await harness.drain();

        expect(startClaudeCompaction).not.toHaveBeenCalled();
        if (evidence.startsWith("cancelled-")) {
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
          expect(
            await Effect.runPromise(
              harness.reactor.listBlockingDeliveries({ threadId, limit: 10 }),
            ),
          ).toEqual([]);
          return;
        }
        if (evidence === "uncertain-user-delivery" || evidence === "inflight-user-delivery") {
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("uncertain");
          expect(
            await Effect.runPromise(
              harness.reactor.listBlockingDeliveries({ threadId, limit: 10 }),
            ),
          ).toMatchObject([{ eventSequence: uncertainUserDeliverySequence, state: "uncertain" }]);
          return;
        }
        if (evidence === "confirmed-invariant-failure") {
          await waitFor(() => harness.sendTurn.mock.calls.length === 1);
          expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
            status: "failed",
            error: "Simulated per-thread recovery invariant failure",
          });
          expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
            threadId: "thread-2",
            input: "Continue the unaffected task",
          });
          return;
        }
        if (evidence === "confirmed-unacknowledged") {
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("compacting");
          await Effect.runPromise(
            harness.runtimeEventRepository.advanceConsumerCursor({
              consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
              eventSequence: terminalSequence!,
              updatedAt: new Date().toISOString(),
            }),
          );
        }
        if (
          evidence === "confirmed" ||
          evidence === "confirmed-after-reconciliation" ||
          evidence === "confirmed-inflight-behind-cursor" ||
          evidence === "confirmed-unacknowledged"
        ) {
          await waitFor(() => harness.sendTurn.mock.calls.length === 1);
          // The ingestion waiter releases the send asynchronously. Entering
          // sendTurn does not mean its durable acknowledgement has completed.
          await waitFor(async () => (await readHarnessThread(harness))?.claudeCacheReview === null);
          expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe(
            "Resume the saved original message",
          );
          expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
        } else {
          expect(harness.sendTurn).not.toHaveBeenCalled();
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("failed");
          if (
            evidence === "uncertain-missing" ||
            evidence === "failed-recovery-interrupted" ||
            evidence === "inflight-behind-cursor"
          ) {
            expect(
              await Effect.runPromise(
                harness.reactor.listBlockingDeliveries({ threadId, limit: 10 }),
              ),
            ).toEqual([]);
            const failedReview = (await readHarnessThread(harness))!.claudeCacheReview!;
            await respondToReview(harness, failedReview, "continue");
            await harness.drain();
            expect(harness.sendTurn).toHaveBeenCalledTimes(1);
            expect(harness.sendTurn.mock.calls[0]?.[0].input).toBe(
              "Resume the saved original message",
            );
            expect(startClaudeCompaction).not.toHaveBeenCalled();
          }
        }
      },
    );

    // Claude Code asks only after a long pause, not because the next send
    // switches models; a model switch alone sends straight away.
    it.each([{ model: "claude-sonnet-4-6", tokens: 120_000 }])(
      "sends a $tokens-token context on the requested $model model without asking after a short pause",
      async ({ model, tokens }) => {
        const createdAt = new Date().toISOString();
        const observation: ClaudeCacheObservation = {
          ...expiredCacheObservation(),
          observedAt: createdAt,
          lastResponseAt: createdAt,
          contextTokens: tokens,
          state: "likely-warm",
        };
        const harness = await createCacheHarness(() => observation);
        await dispatchHarnessUserTurn(harness, {
          messageId: "warm-first-message",
          text: "First message",
          createdAt,
        });
        await harness.drain();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("cmd-cache-model-session-ready"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            session: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              providerName: "claudeAgent",
              status: "ready",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        harness.sendTurn.mockClear();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-cache-warm-model-send"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            message: {
              messageId: asMessageId("warm-model-message"),
              role: "user",
              text: "Continue using this model",
              attachments: [],
            },
            modelSelection: { provider: "claudeAgent", model },
            runtimeMode: "approval-required",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        );
        await harness.drain();
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          input: "Continue using this model",
          modelSelection: { provider: "claudeAgent", model },
        });
        expect((await readHarnessThread(harness))?.claudeCacheReview ?? null).toBeNull();
        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(observation.state).toBe("likely-warm");
      },
    );

    it("holds the first large expired-cache send and later queued messages", async () => {
      const harness = await createCacheHarness();
      const review = await sendHeldMessage(harness);

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(review).toMatchObject({
        messageId: "cache-held-message",
        assessment: { state: "likely-expired", contextTokens: 120_000 },
      });
      expect((await readHarnessThread(harness))?.session?.status).toBe("ready");

      await dispatchHarnessUserTurn(harness, {
        messageId: "cache-later-message",
        text: "This message must remain queued",
        createdAt: new Date().toISOString(),
      });
      await harness.drain();

      const thread = await readHarnessThread(harness);
      expect(thread?.claudeCacheReview?.reviewId).toBe(review.reviewId);
      expect(thread?.messages.map((message) => message.id)).toEqual([
        "cache-held-message",
        "cache-later-message",
      ]);
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it.each(["none", "archive", "stop", "delete"] as const)(
      "recovers a pending review without replaying its original provider send (intervening action: %s)",
      async (interveningAction) => {
        const observation = expiredCacheObservation();
        const harness = await createCacheHarness(() => observation, false);
        const now = new Date().toISOString();
        const receipt = await dispatchHarnessUserTurn(harness, {
          messageId: "cache-recovery-message",
          text: "Hold this message across recovery",
          createdAt: now,
        });
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.claude-cache.set",
            commandId: CommandId.makeUnsafe("cmd-cache-review-before-recovery"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            review: {
              reviewId: "durable-review-before-recovery",
              messageId: asMessageId("cache-recovery-message"),
              sourceEventSequence: receipt.sequence,
              assessment: observation,
              status: "pending",
              createdAt: now,
            },
            expectedReviewId: null,
            createdAt: now,
          }),
        );

        if (interveningAction !== "none") {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-cache-continue-before-archive"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: "durable-review-before-recovery",
              messageId: asMessageId("cache-recovery-message"),
              decision: "continue",
              createdAt: now,
            }),
          );
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).toBe("responding");
          const commandId = CommandId.makeUnsafe(`cmd-cache-${interveningAction}-before-dispatch`);
          const threadId = ThreadId.makeUnsafe("thread-1");
          await Effect.runPromise(
            harness.engine.dispatch(
              interveningAction === "stop"
                ? { type: "thread.session.stop", commandId, threadId, createdAt: now }
                : {
                    type: interveningAction === "archive" ? "thread.archive" : "thread.delete",
                    commandId,
                    threadId,
                  },
            ),
          );
          if (interveningAction === "archive") {
            await Effect.runPromise(
              harness.engine.dispatch({
                type: "thread.unarchive",
                commandId: CommandId.makeUnsafe("cmd-cache-unarchive-before-dispatch"),
                threadId,
              }),
            );
          }
        }

        await harness.startReactor();
        await harness.drain();

        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (interveningAction !== "none") {
          expect((await readHarnessThread(harness))?.claudeCacheReview?.status).not.toBe(
            "responding",
          );
        } else {
          expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
            reviewId: "durable-review-before-recovery",
            status: "pending",
          });
        }
      },
    );

    it("continues the persisted original message once and does not replay duplicate responses", async () => {
      const observation = expiredCacheObservation();
      const harness = await createCacheHarness(() => observation);
      const review = await sendHeldMessage(harness);

      const continueCommand = await respondToReview(harness, review, "continue");
      await waitFor(async () => (await readHarnessThread(harness))?.claudeCacheReview == null);

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId: "thread-1",
        input: "Continue with this exact message",
      });

      await Effect.runPromise(harness.engine.dispatch(continueCommand));
      await harness.drain();
      await expect(respondToReview(harness, review, "continue", "duplicate")).rejects.toThrow(
        "Command produced no events.",
      );
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(
        (await readHarnessThread(harness))?.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    });

    it("cancels the send while retaining the original user message", async () => {
      const harness = await createCacheHarness();
      const review = await sendHeldMessage(harness);
      const pendingBeforeCancel = await Effect.runPromise(harness.sql`
        SELECT pending_message_id FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id IS NULL
      `);
      expect(pendingBeforeCancel).toHaveLength(1);

      await respondToReview(harness, review, "cancel");
      await waitFor(async () => (await readHarnessThread(harness))?.claudeCacheReview == null);

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.messages).toContainEqual(
        expect.objectContaining({
          id: "cache-held-message",
          role: "user",
          text: "Continue with this exact message",
        }),
      );
      expect(
        await Effect.runPromise(harness.sql`
        SELECT pending_message_id FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id IS NULL
      `),
      ).toEqual([]);
    });

    it("creates a recovered cache hold from a shell-only command snapshot", async () => {
      const harness = await createCacheHarness(expiredCacheObservation, false);
      await dispatchHarnessUserTurn(harness, {
        messageId: "recovered-cache-message",
        text: "Preserve this send across recovery",
        createdAt: new Date().toISOString(),
      });
      await waitFor(async () => {
        await Effect.runPromise(harness.engine.refreshCommandReadModel());
        return (
          (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.messages.length === 0
        );
      });
      expect((await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.messages).toEqual(
        [],
      );

      await harness.startReactor();
      await harness.drain();

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
        messageId: "recovered-cache-message",
        status: "pending",
      });
    });

    it("continues a recovered cache hold from a shell-only command snapshot", async () => {
      const observation = expiredCacheObservation();
      const harness = await createCacheHarness(() => observation);
      const review = await sendHeldMessage(harness);
      await waitFor(async () => {
        await Effect.runPromise(harness.engine.refreshCommandReadModel());
        return (
          (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.messages.length === 0
        );
      });
      expect((await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.messages).toEqual(
        [],
      );

      await respondToReview(harness, review, "continue");

      expect((await readHarnessThread(harness))?.claudeCacheReview).toBeNull();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Continue with this exact message",
      });
    });

    it("deletes a held pending turn when its thread is deleted", async () => {
      const harness = await createCacheHarness();
      await sendHeldMessage(harness);
      expect(
        await Effect.runPromise(harness.sql`
        SELECT pending_message_id FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id IS NULL
      `),
      ).toHaveLength(1);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("cmd-delete-cache-hold"),
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      );
      await harness.drain();

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(
        await Effect.runPromise(harness.sql`
        SELECT pending_message_id FROM projection_turns
        WHERE thread_id = 'thread-1' AND turn_id IS NULL
      `),
      ).toEqual([]);
    });

    it("settles a removed held message as failed instead of leaving the review responding", async () => {
      const observation = expiredCacheObservation();
      const harness = await createCacheHarness(() => observation);
      const review = await sendHeldMessage(harness);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.conversation.rollback.complete",
          commandId: CommandId.makeUnsafe("cmd-remove-held-message"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: review.messageId,
          numTurns: 1,
          createdAt: new Date().toISOString(),
        }),
      );
      expect((await readHarnessThread(harness))?.messages).toEqual([]);

      await respondToReview(harness, review, "continue");

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
        reviewId: review.reviewId,
        status: "failed",
        error: expect.stringContaining("could not start"),
      });
    });

    it("allows another thread to send while the first thread awaits cache review", async () => {
      const harness = await createCacheHarness();
      const review = await sendHeldMessage(harness);
      const threadId = ThreadId.makeUnsafe("thread-cache-independent");
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-cache-independent-create"),
          threadId,
          projectId: asProjectId("project-1"),
          title: "Independent thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.succeed({ threadId, turnId: asTurnId("turn-cache-independent") }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-cache-independent-send"),
          threadId,
          message: {
            messageId: asMessageId("cache-independent-message"),
            role: "user",
            text: "Run independently of the pending review",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        input: "Run independently of the pending review",
      });
      expect((await readHarnessThread(harness))?.claudeCacheReview).toMatchObject({
        reviewId: review.reviewId,
        status: "pending",
      });
    });

    it.each([
      ["fresh", "stop"],
      ["fresh", "archive"],
      ["fresh", "delete"],
      ["renewed", "stop"],
      ["renewed", "archive"],
      ["renewed", "delete"],
    ] as const)(
      "does not install a %s hold after %s during cache observation",
      async (mode, action) => {
        const observation = expiredCacheObservation();
        let getterCalls = 0;
        let releaseObservation!: () => void;
        const observationGate = new Promise<void>((resolve) => {
          releaseObservation = resolve;
        });
        const gateCall = mode === "fresh" ? 1 : 2;
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
          getClaudeCacheObservation: () => {
            getterCalls += 1;
            return getterCalls === gateCall
              ? Effect.promise(() => observationGate).pipe(
                  Effect.as({ ...observation, nativeSessionId: "refreshed-native-session" }),
                )
              : Effect.succeed(observation);
          },
        });
        if (mode === "renewed") {
          const review = await sendHeldMessage(harness);
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.claude-cache.respond",
              commandId: CommandId.makeUnsafe("cmd-cache-renew-during-observation"),
              threadId: ThreadId.makeUnsafe("thread-1"),
              reviewId: review.reviewId,
              messageId: review.messageId,
              decision: "continue",
              createdAt: new Date().toISOString(),
            }),
          );
        } else {
          await dispatchHarnessUserTurn(harness, {
            messageId: "cache-held-message",
            text: "Hold only while still authorized",
            createdAt: new Date().toISOString(),
          });
        }
        let cancellationSequence = 0;
        try {
          await waitFor(() => getterCalls === gateCall);
          const commandId = CommandId.makeUnsafe("cmd-cache-cancel-observation");
          const threadId = ThreadId.makeUnsafe("thread-1");
          cancellationSequence = (
            await Effect.runPromise(
              harness.engine.dispatch(
                action === "stop"
                  ? {
                      type: "thread.session.stop",
                      commandId,
                      threadId,
                      createdAt: new Date().toISOString(),
                    }
                  : {
                      type: action === "archive" ? "thread.archive" : "thread.delete",
                      commandId,
                      threadId,
                    },
              ),
            )
          ).sequence;
        } finally {
          releaseObservation();
        }
        await harness.drain();
        const laterEvents = await Effect.runPromise(
          Stream.runCollect(harness.engine.readEvents(cancellationSequence)),
        );
        expect(
          Array.from(laterEvents).filter(
            (event) =>
              (event.type === "thread.claude-cache-set" && event.payload.review !== null) ||
              (event.type === "thread.session-set" && event.payload.session.status === "ready"),
          ),
        ).toEqual([]);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it.each(["stop", "archive", "delete"] as const)(
      "does not restore ready after %s following hold persistence",
      async (action) => {
        const harness = await createCacheHarness();
        const dispatch = harness.engine.dispatch;
        let cancellationSequence = 0;
        harness.interceptEngineDispatch((command) => {
          if (command.type !== "thread.claude-cache.set" || command.review?.status !== "pending")
            return undefined;
          return dispatch(command).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const commandId = CommandId.makeUnsafe("cmd-cache-cancel-after-hold");
                const threadId = ThreadId.makeUnsafe("thread-1");
                const result = yield* dispatch(
                  action === "stop"
                    ? {
                        type: "thread.session.stop",
                        commandId,
                        threadId,
                        createdAt: new Date().toISOString(),
                      }
                    : {
                        type: action === "archive" ? "thread.archive" : "thread.delete",
                        commandId,
                        threadId,
                      },
                );
                cancellationSequence = result.sequence;
              }),
            ),
          );
        });
        await dispatchHarnessUserTurn(harness, {
          messageId: "cache-held-message",
          text: "Do not revive a cancelled hold",
          createdAt: new Date().toISOString(),
        });
        await waitFor(() => cancellationSequence > 0);
        await harness.drain();
        const laterEvents = await Effect.runPromise(
          Stream.runCollect(harness.engine.readEvents(cancellationSequence)),
        );
        expect(
          Array.from(laterEvents).filter(
            (event) =>
              event.type === "thread.session-set" && event.payload.session.status === "ready",
          ),
        ).toEqual([]);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it("continues once when only the observation time refreshes", async () => {
      const observation = {
        ...expiredCacheObservation(),
        observedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      let observations = 0;
      const harness = await createCacheHarness(() => ({
        ...observation,
        observedAt: new Date(
          Date.parse(observation.observedAt) + ++observations * 1_000,
        ).toISOString(),
      }));
      const review = await sendHeldMessage(harness);

      await respondToReview(harness, review, "continue");

      expect(observations).toBe(2);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect((await readHarnessThread(harness))?.claudeCacheReview == null).toBe(true);
    });

    it("allows a new message to create a hold after an earlier stop", async () => {
      const harness = await createCacheHarness();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("cmd-cache-earlier-stop"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();

      const review = await sendHeldMessage(harness);

      expect(review.status).toBe("pending");
      expect((await readHarnessThread(harness))?.session?.status).toBe("ready");
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it.each(["nativeSessionId", "lifecycleGeneration", "model"] as const)(
      "requires a new review when %s changes before Continue",
      async (field) => {
        let observation = expiredCacheObservation();
        const harness = await createCacheHarness(() => observation);
        const review = await sendHeldMessage(harness);
        observation = { ...observation, [field]: `${observation[field]}-changed` };

        await respondToReview(harness, review, "continue");
        await waitFor(
          async () => (await readHarnessThread(harness))?.claudeCacheReview?.status === "pending",
        );

        const renewedReview = (await readHarnessThread(harness))?.claudeCacheReview;
        expect(renewedReview?.reviewId).not.toBe(review.reviewId);
        expect(renewedReview?.messageId).toBe(review.messageId);
        expect(renewedReview?.assessment[field]).toBe(observation[field]);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it.each(["agent", "automation"] as const)(
      "sends %s messages without holding them, like headless Claude Code",
      async (dispatchOrigin) => {
        const harness = await createCacheHarness();

        await dispatchHarnessUserTurn(harness, {
          messageId: `cache-${dispatchOrigin}-message`,
          text: "Worker result for the coordinator",
          createdAt: new Date().toISOString(),
          dispatchOrigin,
        });
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await harness.drain();

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect((await readHarnessThread(harness))?.claudeCacheReview == null).toBe(true);
      },
    );

    it("sends without holding when the user turns the review off", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        getClaudeCacheObservation: () => Effect.sync(expiredCacheObservation),
        serverSettings: { providers: { claudeAgent: { confirmColdCacheResume: false } } },
      });

      await dispatchHarnessUserTurn(harness, {
        messageId: "cache-dismissed-message",
        text: "Send without asking",
        createdAt: new Date().toISOString(),
      });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect((await readHarnessThread(harness))?.claudeCacheReview == null).toBe(true);
    });

    it("continues an active goal without asking when the Claude context is cold", async () => {
      const harness = await createCacheHarness();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-cold-goal"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          goal: "Complete the remaining work",
          goalStartBehavior: "defer",
        }),
      );
      const goalStartedAt = (await readHarnessThread(harness))?.goalStartedAt;
      expect(goalStartedAt).toBeTruthy();

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.continue",
          commandId: CommandId.makeUnsafe("cmd-cold-goal-continue"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          goalStartedAt: goalStartedAt!,
          trigger: "turn-completed",
          createdAt: new Date().toISOString(),
        }),
      );
      await harness.drain();

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect((await readHarnessThread(harness))?.goalPausedAt ?? null).toBeNull();
      expect((await readHarnessThread(harness))?.claudeCacheReview == null).toBe(true);
    });
  });

  it("regenerates a title from durable conversation context without steering an active turn", async () => {
    const harness = await createHarness();
    await seedRenameConversation(harness);
    harness.generateThreadTitle.mockImplementationOnce((input) =>
      harness.engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-activity-during-title-generation"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe("activity-during-title-generation"),
            tone: "info",
            kind: "provider.notice",
            summary: "Active turn produced durable progress",
            payload: {},
            turnId: null,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        })
        .pipe(
          Effect.orDie,
          Effect.as({
            title: input.message.includes("backend authentication")
              ? "Backend auth callback"
              : "Unexpected title",
          }),
        ),
    );
    harness.setRuntimeSessionTurnState({
      threadId: "thread-1",
      status: "running",
      activeTurnId: asTurnId("turn-active-rename"),
    });

    const result = await Effect.runPromise(
      harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );

    expect(result).toEqual({ status: "renamed", title: "Backend auth callback" });
    expect(harness.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/provider-project",
        context: "conversation",
        modelSelection: {
          provider: "codex",
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        message: expect.stringContaining("User: Fix the backend authentication callback race"),
      }),
    );
    expect((await readHarnessThread(harness))?.title).toBe("Backend auth callback");
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();
  });

  it("uses persisted provider configuration before any runtime session exists", async () => {
    const harness = await createHarness({
      startReactor: false,
      threadModelSelection: { provider: "opencode", model: "openai/gpt-5" },
      serverSettings: {
        providers: {
          opencode: {
            binaryPath: "/custom/opencode",
            serverUrl: "http://127.0.0.1:4096",
          },
        },
      },
    });
    await seedRenameConversation(harness);
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Recovered provider title" }),
    );
    await Effect.runPromise(
      harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );
    expect(harness.generateThreadTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          provider: "opencode",
          instanceId: "opencode",
          model: "openai/gpt-5",
        },
        providerOptions: expect.objectContaining({
          opencode: expect.objectContaining({
            binaryPath: "/custom/opencode",
            serverUrl: "http://127.0.0.1:4096",
          }),
        }),
      }),
    );
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("shares concurrent title regeneration and permits a later request", async () => {
    const harness = await createHarness();
    await seedRenameConversation(harness);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.generateThreadTitle.mockImplementation(() =>
      Effect.promise(() => waiting).pipe(Effect.as({ title: "Concurrent title" })),
    );
    const input = { threadId: ThreadId.makeUnsafe("thread-1") };
    const first = Effect.runPromise(harness.reactor.regenerateThreadTitle(input));
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    const second = Effect.runPromise(harness.reactor.regenerateThreadTitle(input));
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    expect(await Promise.all([first, second])).toEqual([
      { status: "renamed", title: "Concurrent title" },
      { status: "renamed", title: "Concurrent title" },
    ]);
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    await Effect.runPromise(harness.reactor.regenerateThreadTitle(input));
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(2);
  });

  it("discards title generation after thread.archive", async () => {
    const harness = await createHarness();
    await seedRenameConversation(harness);
    harness.generateThreadTitle.mockImplementationOnce(() =>
      harness.engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-rename-thread.archive"),
          threadId: ThreadId.makeUnsafe("thread-1"),
        })
        .pipe(Effect.orDie, Effect.as({ title: "Stale lifecycle title" })),
    );
    const result = await Effect.runPromise(
      harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );
    expect(result).toEqual({ status: "stale", title: null });
  });

  it("does not invoke title generation without durable user context", async () => {
    const harness = await createHarness();

    const result = await Effect.runPromise(
      harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );

    expect(result).toEqual({ status: "no-context", title: null });
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect((await readHarnessThread(harness))?.title).toBe("Thread");
  });

  it("discards a generated title after an explicit A-to-B-to-A rename", async () => {
    const harness = await createHarness();
    await seedRenameConversation(harness);
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.gen(function* () {
        yield* harness.engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-explicit-rename-away-during-generation"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            title: "Temporary explicit title",
          })
          .pipe(Effect.orDie);
        yield* harness.engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-explicit-rename-back-during-generation"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            title: "Thread",
          })
          .pipe(Effect.orDie);
        return { title: "Generated stale title" };
      }),
    );

    const result = await Effect.runPromise(
      harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
    );

    expect(result).toEqual({ status: "stale", title: null });
    expect((await readHarnessThread(harness))?.title).toBe("Thread");
  });

  it("keeps the old title when regeneration fails", async () => {
    const harness = await createHarness();
    await seedRenameConversation(harness);

    await expect(
      Effect.runPromise(
        harness.reactor.regenerateThreadTitle({ threadId: ThreadId.makeUnsafe("thread-1") }),
      ),
    ).rejects.toThrow(/disabled in test harness/);
    expect((await readHarnessThread(harness))?.title).toBe("Thread");
  });

  it("REL-01B gate: delivers intents committed before the reactor subscribes", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = new Date().toISOString();
    const commandId = CommandId.makeUnsafe("cmd-durable-before-subscribe");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-durable-before-subscribe");

    harness.setRuntimeSessionTurnState({
      threadId,
      status: "running",
      activeTurnId: turnId,
    });
    await harness.persistSessionWithoutLivePublication({ threadId, turnId, updatedAt: now });

    await harness.persistWithoutLivePublication([
      {
        eventId: asEventId("evt-durable-interrupt-before-subscribe"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId,
          turnId,
          createdAt: now,
        },
      },
    ]);
    expect(harness.interruptTurn).not.toHaveBeenCalled();

    await harness.startReactor();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      turnId,
    });
  });

  it("stops a stuck-starting session without a live turn", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    // A missing turn.started can leave a placeholder with a runtime that has
    // not accepted a turn; any non-running runtime resolves to no live turn.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-stuck-starting-session"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    harness.setRuntimeSessionTurnState({ threadId, status: "ready" });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-stop-stuck-starting"),
        threadId,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect((await readHarnessThread(harness))?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    });
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.stopRuntimeSession).toHaveBeenCalledWith({
      threadId,
      controlRequestId: "command:cmd-stop-stuck-starting",
      expectedLifecycleGeneration: null,
    });
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await Effect.runPromise(harness.listSessions())).toEqual([]);
  });

  it("stops only a starting child when its parent runtime is connecting without a turn id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const parent = ThreadId.makeUnsafe("thread-1");
    const child = ThreadId.makeUnsafe("subagent:thread-1:connecting-child");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("create-connecting-child"),
        threadId: child,
        parentThreadId: parent,
        projectId: asProjectId("project-1"),
        title: "Starting child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );
    for (const threadId of [parent, child]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`session-${threadId}`),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    }
    harness.setRuntimeSessionTurnState({ threadId: parent, status: "connecting" });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("stop-connecting-child"),
        threadId: child,
        createdAt: now,
      }),
    );
    await harness.drain();
    const state = await Effect.runPromise(harness.engine.getReadModel());
    expect(state.threads.find((entry) => entry.id === child)?.session).toMatchObject({
      status: "stopped",
      activeTurnId: null,
    });
    expect(state.threads.find((entry) => entry.id === parent)?.session?.status).toBe("starting");
    expect(await Effect.runPromise(harness.listSessions())).toMatchObject([
      { threadId: parent, status: "connecting" },
    ]);
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("interrupts the live turn when the starting projection has not received its turn id", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-starting-before-runtime-event"),
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.setRuntimeSessionTurnState({
      threadId,
      status: "running",
      activeTurnId: asTurnId("turn-not-yet-projected"),
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-stop-before-runtime-event"),
        threadId,
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.interruptTurn).toHaveBeenCalledWith({
      threadId,
      turnId: "turn-not-yet-projected",
      controlRequestId: "command:cmd-stop-before-runtime-event",
      expectedLifecycleGeneration: null,
    });
    expect(harness.stopRuntimeSession).not.toHaveBeenCalled();
  });

  it("REL-01B gate: advances the durable cursor through irrelevant events", async () => {
    const harness = await createHarness({ startReactor: false });
    const before = await Effect.runPromise(
      harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
    );
    expect(before.pipe(Option.getOrThrow).lastAckedSequence).toBe(0);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const lastSequence = events.at(-1)!.sequence;
    await harness.startReactor();

    const after = await Effect.runPromise(
      harness.deliveryRepository.getConsumerState("provider-command-reactor.v1"),
    );
    expect(after.pipe(Option.getOrThrow).lastAckedSequence).toBe(lastSequence);
    const projectDelivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: events[0]!.sequence,
      }),
    );
    expect(Option.isNone(projectDelivery)).toBe(true);
  });

  it("REL-01B gate: reclaims an expired safe claim during startup replay", async () => {
    const harness = await createHarness({ startReactor: false });
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const threadCreated = events.find((event) => event.type === "thread.created")!;
    await Effect.runPromise(
      harness.deliveryRepository.claim({
        consumerName: "provider-command-reactor.v1",
        eventSequence: threadCreated.sequence,
        threadId: ThreadId.makeUnsafe("thread-1"),
        claimOwner: "crashed-process",
        claimedAt: "2020-01-01T00:00:00.000Z",
        claimExpiresAt: "2020-01-01T00:01:00.000Z",
      }),
    );

    await harness.startReactor();
    const delivery = await Effect.runPromise(
      harness.deliveryRepository.getDelivery({
        consumerName: "provider-command-reactor.v1",
        eventSequence: threadCreated.sequence,
      }),
    );
    expect(delivery.pipe(Option.getOrThrow)).toMatchObject({
      state: "succeeded",
      attemptCount: 2,
    });
  });

  it("recovers a retryable delivery ahead of the source cursor before replaying its settled prefix", async () => {
    const harness = await createHarness({ startReactor: false });
    const events = Array.from(
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0))),
    );
    const event = events.find((candidate) => candidate.type === "thread.created")!;
    const key = { consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER, eventSequence: event.sequence };
    await Effect.runPromise(
      harness.deliveryRepository.claim({
        ...key,
        threadId: "thread-1",
        claimOwner: "previous-process",
        claimedAt: "2020-01-01T00:00:00.000Z",
        claimExpiresAt: "2020-01-01T00:01:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.deliveryRepository.markRetryable({
        ...key,
        expectedClaimOwner: "previous-process",
        error: "safe retry before dispatch",
        updatedAt: new Date().toISOString(),
      }),
    );
    await harness.startReactor();
    expect(
      Option.getOrThrow(await Effect.runPromise(harness.deliveryRepository.getDelivery(key))),
    ).toMatchObject({ state: "succeeded", attemptCount: 2 });
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.deliveryRepository.getConsumerState(key.consumerName)),
      ).lastAckedSequence,
    ).toBe(events.at(-1)!.sequence);
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });
});
