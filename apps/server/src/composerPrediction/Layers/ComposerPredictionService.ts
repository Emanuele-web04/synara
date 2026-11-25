// FILE: ComposerPredictionService.ts (layer)
// Purpose: Composer predictions. Reads the thread from the projection, checks that the
//          expected turn is still the settled latest one, builds a bounded transcript, and
//          asks the chat's own provider instance for one predicted next user message
//          through the isolated text-generation path. Decisions live in
//          `composerPrediction.ts`.
// Layer: Server service

import type { ComposerPredictionOutcome, ThreadId, TurnId } from "@synara/contracts";
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { COMPOSER_PREDICTION_CONTEXT_BUDGET } from "../../git/textGenerationShared.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildComposerPredictionConversation,
  resolveComposerPredictionHedgeDelayMs,
  resolveComposerPredictionRouting,
  resolveComposerPredictionTurnBlocker,
  type ComposerPredictionTurnBlocker,
} from "../composerPrediction.ts";
import {
  ComposerPredictionService,
  type ComposerPredictionServiceShape,
} from "../Services/ComposerPredictionService.ts";

/** A prediction that takes longer than this is no longer worth showing. */
export const COMPOSER_PREDICTION_TIMEOUT = Duration.seconds(20);

/**
 * How long a request waits before it reads the transcript and starts the provider CLI
 * (about 0.3 to 0.4 GB and 0.7 to 3 CPU seconds per run). Leaving the chat or turn
 * inside this window cancels the request before a process starts. Otherwise the delay
 * gives opening the chat or settling the turn time to finish.
 */
export const COMPOSER_PREDICTION_START_DELAY = Duration.seconds(1);

/** Answers kept so another window or device asking for the same turn starts no second CLI. */
const ANSWER_CACHE_LIMIT = 64;

/** Completed generation times kept per route to decide when a second attempt is worth it. */
const RECENT_DURATION_SAMPLES = 5;

interface ComposerPredictionAnswer {
  readonly suggestion: string | null;
  readonly outcome: ComposerPredictionOutcome;
}

/**
 * Why a request got no answer this time, one content-free code per miss. Routing is here
 * and not a `none`: it follows settings and the chat's model, which the user can change
 * for the same turn, so a client must not remember it as the turn's answer.
 */
type ComposerPredictionUnavailableReason =
  | ComposerPredictionTurnBlocker
  | "no-routing"
  | "no-conversation"
  | "timeout"
  | "generation-failed"
  | "unexpected-failure";

/** Misses that point at the provider rather than at the thread's state. */
const FAILURE_REASONS: ReadonlySet<ComposerPredictionUnavailableReason> = new Set([
  "timeout",
  "generation-failed",
  "unexpected-failure",
]);

/** The model's own answer: a suggestion, or its decision that there is none. */
const modelAnswer = (suggestion: string | null): ComposerPredictionAnswer =>
  suggestion ? { suggestion, outcome: "suggested" } : { suggestion: null, outcome: "none" };

interface SharedPrediction {
  readonly result: Deferred.Deferred<ComposerPredictionAnswer>;
  fiber: Fiber.Fiber<void> | undefined;
  waiters: number;
}

const make = Effect.fnUntraced(function* (options: { readonly startDelay: Duration.Input }) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const layerScope = yield* Effect.scope;
  const pending = new Map<string, SharedPrediction>();
  // Keyed by provider instance and model: how long this route's generations usually take.
  const recentDurationsMs = new Map<string, ReadonlyArray<number>>();
  // Keyed by thread, turn and route, oldest first: the model's answer, including "none".
  const answers = new Map<string, string | null>();
  const rememberAnswer = (key: string, suggestion: string | null) => {
    answers.delete(key);
    answers.set(key, suggestion);
    for (const oldest of answers.keys()) {
      if (answers.size <= ANSWER_CACHE_LIMIT) break;
      answers.delete(oldest);
    }
  };

  const readThread = (threadId: ThreadId) =>
    snapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const generateOnce = (
    threadId: ThreadId,
    expectedTurnId: TurnId,
  ): Effect.Effect<ComposerPredictionAnswer> => {
    // Logs the one reason code for this miss. Ids only: no provider detail, prompt, or reply.
    const unavailable = (
      reason: ComposerPredictionUnavailableReason,
      generationMayHaveRun = FAILURE_REASONS.has(reason),
    ) =>
      (FAILURE_REASONS.has(reason) ? Effect.logWarning : Effect.logInfo)(
        "Composer prediction unavailable",
        { threadId, expectedTurnId, reason },
      ).pipe(
        Effect.as<ComposerPredictionAnswer>({
          suggestion: null,
          outcome: generationMayHaveRun ? "generation-unavailable" : "unavailable",
        }),
      );

    return Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      const blocker = resolveComposerPredictionTurnBlocker(thread, expectedTurnId);
      if (blocker !== null) return yield* unavailable(blocker);
      const finalReplyMessageId = thread?.latestTurn?.assistantMessageId;
      if (!thread || !finalReplyMessageId) return yield* unavailable("turn-incomplete");

      const routing = resolveComposerPredictionRouting({
        thread,
        settings: yield* serverSettings.getSettings,
      });
      if (!routing) return yield* unavailable("no-routing");
      const routeKey = JSON.stringify([
        routing.modelSelection.instanceId ?? routing.modelSelection.provider,
        routing.modelSelection.model,
      ]);
      const answerKey = JSON.stringify([threadId, expectedTurnId, routeKey]);
      if (answers.has(answerKey)) return modelAnswer(answers.get(answerKey) ?? null);

      yield* Effect.sleep(options.startDelay);
      const delayedBlocker = resolveComposerPredictionTurnBlocker(
        yield* readThread(threadId),
        expectedTurnId,
      );
      if (delayedBlocker !== null) return yield* unavailable(delayedBlocker);

      const context = yield* snapshotQuery.getThreadMentionContextById(threadId, {
        messageLimit: COMPOSER_PREDICTION_CONTEXT_BUDGET.messageLimit,
      });
      const conversation = Option.isSome(context)
        ? buildComposerPredictionConversation({
            messages: context.value.messages,
            finalReplyMessageId,
          })
        : null;
      if (!conversation) return yield* unavailable("no-conversation");

      const project = yield* snapshotQuery.getProjectShellById(thread.projectId);
      const cwd = Option.isSome(project)
        ? resolveThreadWorkspaceCwd({ thread, projects: [project.value] })
        : undefined;
      const attempt = Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const result = yield* textGeneration.generateComposerPrediction({
          cwd: cwd ?? process.cwd(),
          conversation,
          modelSelection: routing.modelSelection,
          ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
          ...(routing.codexHomePath ? { codexHomePath: routing.codexHomePath } : {}),
        });
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
        recentDurationsMs.set(
          routeKey,
          [...(recentDurationsMs.get(routeKey) ?? []), elapsedMs].slice(-RECENT_DURATION_SAMPLES),
        );
        return result;
      });
      // A provider backend sometimes stalls for many seconds on a request that normally takes
      // three. Once the route's usual time has clearly passed, a second attempt races the
      // first. The first one keeps its normal outcome (a fast failure still fails fast); a
      // second attempt that fails is ignored, so it can never cancel a first one that is
      // still on its way. A route that is slow by nature gets no second attempt.
      const hedgeDelayMs = resolveComposerPredictionHedgeDelayMs({
        recentDurationsMs: recentDurationsMs.get(routeKey) ?? [],
        timeoutMs: Duration.toMillis(COMPOSER_PREDICTION_TIMEOUT),
      });
      const generation =
        hedgeDelayMs === null
          ? attempt
          : Effect.raceFirst(
              attempt,
              Effect.delay(attempt, Duration.millis(hedgeDelayMs)).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.never,
                ),
              ),
            );
      const generated = yield* generation.pipe(Effect.timeoutOption(COMPOSER_PREDICTION_TIMEOUT));
      if (Option.isNone(generated)) return yield* unavailable("timeout");

      // The thread may have moved on while the model was thinking.
      const settledBlocker = resolveComposerPredictionTurnBlocker(
        yield* readThread(threadId),
        expectedTurnId,
      );
      if (settledBlocker !== null) return yield* unavailable(settledBlocker, true);
      // Only a real answer from the model is remembered, "none" included.
      rememberAnswer(answerKey, generated.value.suggestion);
      return modelAnswer(generated.value.suggestion);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        // No provider detail: a CLI failure message can echo prompt or reply text.
        return unavailable(
          Schema.is(TextGenerationError)(Cause.squash(cause))
            ? "generation-failed"
            : "unexpected-failure",
        );
      }),
    );
  };

  // One generation per thread and turn. Every caller awaits the same result;
  // the generation is interrupted only once no caller is still waiting.
  const generateShared = (threadId: ThreadId, expectedTurnId: TurnId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = JSON.stringify([threadId, expectedTurnId]);
        let shared = pending.get(key);
        if (!shared) {
          const created: SharedPrediction = {
            result: Deferred.makeUnsafe<ComposerPredictionAnswer>(),
            fiber: undefined,
            waiters: 0,
          };
          pending.set(key, created);
          created.fiber = yield* generateOnce(threadId, expectedTurnId).pipe(
            // Leave the map before waking the waiters, so a request that arrives once this
            // one is answered starts afresh (or reads the remembered answer) instead of
            // joining a finished generation.
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (pending.get(key) === created) pending.delete(key);
              }).pipe(Effect.andThen(Deferred.done(created.result, exit))),
            ),
            Effect.asVoid,
            Effect.forkIn(layerScope),
          );
          shared = created;
        }
        const current = shared;
        current.waiters += 1;
        return yield* restore(Deferred.await(current.result)).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              current.waiters -= 1;
              if (current.waiters > 0 || Deferred.isDoneUnsafe(current.result)) return Effect.void;
              if (pending.get(key) === current) pending.delete(key);
              return current.fiber ? Fiber.interrupt(current.fiber) : Effect.void;
            }),
          ),
        );
      }),
    );

  const generate: ComposerPredictionServiceShape["generate"] = (input) =>
    generateShared(input.threadId, input.expectedTurnId);

  return { generate } satisfies ComposerPredictionServiceShape;
});

export const makeComposerPredictionServiceLive = (
  options: { readonly startDelay?: Duration.Input } = {},
) =>
  Layer.effect(
    ComposerPredictionService,
    make({ startDelay: options.startDelay ?? COMPOSER_PREDICTION_START_DELAY }),
  );

export const ComposerPredictionServiceLive = makeComposerPredictionServiceLive();
