import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ComposerPredictionService } from "../Services/ComposerPredictionService.ts";
import { ComposerPredictionServiceLive } from "./ComposerPredictionService.ts";

vi.mock("../../betaFeatureGate.ts", () => ({ isServerBetaFeatureEnabled: vi.fn(() => true) }));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const TURN_ID = TurnId.makeUnsafe("turn-2");
const FINAL_REPLY = MessageId.makeUnsafe("assistant-final");
const NOW = "2026-11-10T10:00:00.000Z";
const INPUT = { threadId: THREAD_ID, expectedTurnId: TURN_ID };

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

function makeHarness(options: { readonly modelSelection?: ModelSelection } = {}) {
  const state = {
    thread: makeThread(options.modelSelection ?? CLAUDE_CHAT) as OrchestrationThreadShell,
  };
  const snapshotQuery = {
    getThreadShellById: () => Effect.sync(() => Option.some(state.thread)),
    getThreadMentionContextById: () =>
      Effect.succeed(
        Option.some({
          id: THREAD_ID,
          title: "Thread",
          modelSelection: state.thread.modelSelection,
          messages: MESSAGES,
          totalMessageCount: MESSAGES.length,
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
  const layer = ComposerPredictionServiceLive.pipe(
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provide(
      Layer.succeed(TextGeneration, {
        generateComposerPrediction,
      } as unknown as TextGenerationShape),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestClock.layer()),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, ComposerPredictionService | TestClock.TestClock | Scope.Scope>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
  const generate = Effect.flatMap(ComposerPredictionService.asEffect(), (service) =>
    service.generate(INPUT),
  );
  return { state, generateComposerPrediction, run, generate };
}

describe("ComposerPredictionServiceLive", () => {
  beforeEach(() => {
    vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(true);
  });

  it("predicts from the settled turn on the chat's own instance at its lowest effort", async () => {
    const harness = makeHarness();

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Fix the fixture and rerun that test.",
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
          model: "claude-opus-4-8",
          options: { effort: "low" },
        }),
      }),
    );
  });

  it("refuses the request when the Beta feature is off", async () => {
    vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(false);
    const harness = makeHarness();

    await expect(harness.run(harness.generate)).rejects.toMatchObject({
      code: "FEATURE_UNAVAILABLE",
    });
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("returns null without generating when the expected turn is no longer the latest", async () => {
    const harness = makeHarness();
    harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));

    await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null });
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("discards a suggestion when a new turn starts during generation", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockImplementation(() =>
      Effect.sync(() => {
        harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));
        return { suggestion: "Stale suggestion" };
      }),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null });
  });

  it("never falls back to the Git-writing model for a chat provider without text generation", async () => {
    const harness = makeHarness({
      modelSelection: { provider: "grok", instanceId: "grok", model: "grok-4.6" } as ModelSelection,
    });

    await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null });
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("returns null when generation fails", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null });
  });

  it("returns null when generation outlives its timeout", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(Effect.never);

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("20 seconds");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: null });
  });

  it("races a stalled generation with a second attempt and takes the first to settle", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction
      .mockReturnValueOnce(Effect.never)
      .mockReturnValueOnce(Effect.succeed({ suggestion: "From the second attempt" }));

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("5 seconds");
        expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the second attempt" });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("does not start a second attempt when the first one fails fast", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null });
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
      { suggestion: "Shared suggestion" },
      { suggestion: "Shared suggestion" },
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
    expect(kept).toEqual({ suggestion: "Kept suggestion" });
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
});
