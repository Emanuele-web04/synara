import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ComposerPredictionService } from "../Services/ComposerPredictionService.ts";
import {
  COMPOSER_PREDICTION_START_DELAY,
  makeComposerPredictionServiceLive,
} from "./ComposerPredictionService.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const TURN_ID = TurnId.makeUnsafe("turn-2");
const FINAL_REPLY = MessageId.makeUnsafe("assistant-final");
const NOW = "2026-11-10T10:00:00.000Z";
const INPUT = { threadId: THREAD_ID, expectedTurnId: TURN_ID };
const UNAVAILABLE = { suggestion: null, outcome: "unavailable" };
const GENERATION_UNAVAILABLE = { suggestion: null, outcome: "generation-unavailable" };

function makeThread(modelSelection: ModelSelection, turnId = TURN_ID): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-1"),
    modelSelection,
    envMode: "local",
    worktreePath: null,
    workingDirectory: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: FINAL_REPLY,
    },
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: modelSelection.provider,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
  } as unknown as OrchestrationThreadShell;
}

const MESSAGES = [
  { id: "user-1", role: "user", text: "Investigate the red CI run", streaming: false },
  {
    id: FINAL_REPLY,
    role: "assistant",
    text: "A stale fixture breaks parser.test.ts.",
    streaming: false,
  },
] as unknown as OrchestrationMessage[];

const CLAUDE_CHAT = {
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  model: "claude-opus-4-8",
} as ModelSelection;

function makeHarness(
  options: {
    readonly modelSelection?: ModelSelection;
    /** The production delay where a test is about it; none elsewhere, so timings stay exact. */
    readonly startDelay?: Duration.Input;
  } = {},
) {
  const state = {
    thread: makeThread(options.modelSelection ?? CLAUDE_CHAT) as OrchestrationThreadShell,
    messages: MESSAGES,
    missing: false,
  };
  const snapshotQuery = {
    getThreadShellById: () =>
      Effect.sync(() => (state.missing ? Option.none() : Option.some(state.thread))),
    getThreadMentionContextById: () =>
      Effect.succeed(
        Option.some({
          id: THREAD_ID,
          title: "Thread",
          modelSelection: state.thread.modelSelection,
          messages: state.messages,
          totalMessageCount: state.messages.length,
        }),
      ),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({ id: ProjectId.makeUnsafe("project-1"), workspaceRoot: "/tmp/project-1" }),
      ),
  } as unknown as ProjectionSnapshotQueryShape;
  const generateComposerPrediction = vi.fn<TextGenerationShape["generateComposerPrediction"]>(() =>
    Effect.succeed({ suggestion: "Fix the fixture and rerun that test." }),
  );
  const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => logs.push({ level: logLevel, message }));
  const layer = makeComposerPredictionServiceLive({
    startDelay: options.startDelay ?? Duration.zero,
  }).pipe(
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provide(
      Layer.succeed(TextGeneration, {
        generateComposerPrediction,
      } as unknown as TextGenerationShape),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, ComposerPredictionService | TestClock.TestClock | Scope.Scope>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
  const generateFor = (expectedTurnId: TurnId) =>
    Effect.flatMap(ComposerPredictionService.asEffect(), (service) =>
      service.generate({ ...INPUT, expectedTurnId }),
    );
  const generate = generateFor(TURN_ID);
  /** Moves the chat on to a new settled turn and asks for that turn's prediction. */
  const generateForNextTurn = (turnId: string) => {
    const next = TurnId.makeUnsafe(turnId);
    state.thread = makeThread(state.thread.modelSelection, next);
    return generateFor(next);
  };
  return {
    state,
    logs,
    generateComposerPrediction,
    run,
    generate,
    generateFor,
    generateForNextTurn,
  };
}

describe("ComposerPredictionServiceLive", () => {
  it("predicts from the settled turn on the chat's own instance with its smaller model", async () => {
    const harness = makeHarness();

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
    expect(harness.generateComposerPrediction).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/project-1",
        conversation:
          "User: Investigate the red CI run\n\nAssistant: A stale fixture breaks parser.test.ts.",
        modelSelection: expect.objectContaining({
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          model: "claude-sonnet-5-5",
          options: { effort: "low" },
        }),
      }),
    );
  });

  it("is unavailable without generating when the expected turn is no longer the latest", async () => {
    const harness = makeHarness();
    harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it.each([
    ["a starting session", { session: { status: "starting" } }],
    ["a running session", { session: { status: "running" } }],
    ["a pending approval", { hasPendingApprovals: true }],
    ["a pending user-input request", { hasPendingUserInput: true }],
  ])("is unavailable without generating while the thread has %s", async (_label, overrides) => {
    const harness = makeHarness();
    const thread = harness.state.thread;
    harness.state.thread = {
      ...thread,
      ...overrides,
      ...("session" in overrides ? { session: { ...thread.session, ...overrides.session } } : {}),
    } as OrchestrationThreadShell;

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("is unavailable when the thread is missing", async () => {
    const harness = makeHarness();
    harness.state.missing = true;

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("is unavailable when the session turns busy during the start delay", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        const thread = harness.state.thread;
        harness.state.thread = {
          ...thread,
          session: { ...thread.session, status: "running" },
        } as OrchestrationThreadShell;
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("is unavailable when the final reply is not in the transcript yet", async () => {
    const harness = makeHarness();
    harness.state.messages = MESSAGES.slice(0, 1);

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("discards a suggestion when a new turn starts during generation, and keeps no answer", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockImplementationOnce(() =>
      Effect.sync(() => {
        harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));
        return { suggestion: "Stale suggestion" };
      }),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const stale = yield* harness.generate;
        // Back on the first turn (a projection that briefly ran ahead): it asks again.
        harness.state.thread = makeThread(CLAUDE_CHAT);
        return [stale, yield* harness.generate];
      }),
    );

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("is unavailable, and never falls back to the Git-writing model, for a chat provider without text generation", async () => {
    const harness = makeHarness({
      modelSelection: { provider: "grok", instanceId: "grok", model: "grok-4.6" } as ModelSelection,
    });

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("is none when the model answers without a suggestion", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: null,
      outcome: "none",
    });
  });

  it("is unavailable when generation fails", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
  });

  it("is unavailable when generation outlives its timeout, and asks again afterwards", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(Effect.never);

    const results = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("20 seconds");
        const timedOut = yield* Fiber.join(fiber);
        harness.generateComposerPrediction.mockReturnValue(
          Effect.succeed({ suggestion: "Fix the fixture and rerun that test." }),
        );
        return [timedOut, yield* harness.generate];
      }),
    );

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
  });

  it("races a stalled generation with a second attempt and takes the first to settle", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction
      .mockReturnValueOnce(Effect.never)
      .mockReturnValueOnce(Effect.succeed({ suggestion: "From the second attempt" }));

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("9 seconds");
        expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the second attempt", outcome: "suggested" });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting for the first attempt when the second one fails", async () => {
    const harness = makeHarness();
    const release = Deferred.makeUnsafe<void>();
    harness.generateComposerPrediction
      .mockReturnValueOnce(
        Deferred.await(release).pipe(Effect.as({ suggestion: "From the first attempt" })),
      )
      .mockReturnValueOnce(
        Effect.fail(
          new TextGenerationError({ operation: "generateComposerPrediction", detail: "busy" }),
        ),
      );

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("10 seconds");
        expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the first attempt", outcome: "suggested" });
  });

  it("starts the second attempt sooner once the route has proven fast", async () => {
    const harness = makeHarness();

    const result = await harness.run(
      Effect.gen(function* () {
        yield* harness.generate;
        harness.generateComposerPrediction
          .mockReturnValueOnce(Effect.never)
          .mockReturnValueOnce(Effect.succeed({ suggestion: "From the second attempt" }));
        const fiber = yield* Effect.forkChild(harness.generateForNextTurn("turn-3"));
        yield* TestClock.adjust("6 seconds");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the second attempt", outcome: "suggested" });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(3);
  });

  it("starts no second attempt on a route that is slow by nature", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValueOnce(
      Effect.delay(Effect.succeed({ suggestion: "Slow but fine" }), "9 seconds"),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("9 seconds");
        const firstResult = yield* Fiber.join(first);
        harness.generateComposerPrediction.mockReturnValueOnce(Effect.never);
        const second = yield* Effect.forkChild(harness.generateForNextTurn("turn-3"));
        yield* TestClock.adjust("20 seconds");
        return [firstResult, yield* Fiber.join(second)];
      }),
    );

    expect(results).toEqual([
      { suggestion: "Slow but fine", outcome: "suggested" },
      GENERATION_UNAVAILABLE,
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("does not start a second attempt when the first one fails fast", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("shares one generation between concurrent requests for the same turn", async () => {
    const harness = makeHarness();
    const release = Deferred.makeUnsafe<void>();
    harness.generateComposerPrediction.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ suggestion: "Shared suggestion" })),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        const second = yield* Effect.forkChild(harness.generate);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        return [yield* Fiber.join(first), yield* Fiber.join(second)];
      }),
    );

    expect(results).toEqual([
      { suggestion: "Shared suggestion", outcome: "suggested" },
      { suggestion: "Shared suggestion", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared generation for the remaining caller and stops it after the last one", async () => {
    const harness = makeHarness();
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let interrupted = false;
    // Signal after a yield, like real provider IO, so the signal never runs the
    // waiting test fiber inline while the generation is still being set up.
    harness.generateComposerPrediction.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as({ suggestion: "Kept suggestion" }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );

    const kept = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        const second = yield* Effect.forkChild(harness.generate);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(second);
      }),
    );
    expect(kept).toEqual({ suggestion: "Kept suggestion", outcome: "suggested" });
    expect(interrupted).toBe(false);

    const abandoned = makeHarness();
    const abandonedStarted = Deferred.makeUnsafe<void>();
    abandoned.generateComposerPrediction.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(abandonedStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const exit = await abandoned.run(
      Effect.gen(function* () {
        const only = yield* Effect.forkChild(abandoned.generate);
        yield* Deferred.await(abandonedStarted);
        yield* Fiber.interrupt(only);
        return yield* Fiber.await(only);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(interrupted).toBe(true);
  });

  it("starts no provider CLI for a request abandoned within the start delay", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const exit = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(COMPOSER_PREDICTION_START_DELAY);
        return yield* Fiber.await(fiber);
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("generates once the start delay has passed", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("returns a turn's answer again without a second generation, a null one too", async () => {
    const harness = makeHarness();

    const answered = await harness.run(
      Effect.gen(function* () {
        const first = yield* harness.generate;
        harness.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));
        const again = yield* harness.generate;
        const declined = yield* harness.generateForNextTurn("turn-3");
        const declinedAgain = yield* harness.generateFor(TurnId.makeUnsafe("turn-3"));
        return [first, again, declined, declinedAgain];
      }),
    );

    expect(answered).toEqual([
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
      { suggestion: null, outcome: "none" },
      { suggestion: null, outcome: "none" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("logs one content-free reason code per unavailable answer", async () => {
    const failing = makeHarness();
    failing.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({
          operation: "generateComposerPrediction",
          detail: "User: secret prompt text",
        }),
      ),
    );
    await failing.run(failing.generate);
    expect(failing.logs).toEqual([
      {
        level: "Warn",
        message: [
          "Composer prediction unavailable",
          { threadId: THREAD_ID, expectedTurnId: TURN_ID, reason: "generation-failed" },
        ],
      },
    ]);
    expect(JSON.stringify(failing.logs)).not.toContain("secret");

    const busy = makeHarness();
    busy.state.thread = { ...busy.state.thread, hasPendingApprovals: true };
    await busy.run(busy.generate);
    expect(busy.logs).toEqual([
      {
        level: "Info",
        message: [
          "Composer prediction unavailable",
          { threadId: THREAD_ID, expectedTurnId: TURN_ID, reason: "pending-approval" },
        ],
      },
    ]);

    const answered = makeHarness();
    answered.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));
    await answered.run(answered.generate);
    expect(answered.logs).toEqual([]);
  });

  it("asks again after a failed generation instead of reusing it", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValueOnce(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    const results = await harness.run(Effect.all([harness.generate, harness.generate]));

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });
});
