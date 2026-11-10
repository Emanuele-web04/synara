// FILE: ComposerPredictionService.ts (layer)
// Purpose: Composer predictions. Reads the thread from the projection, checks that the
//          expected turn is still the settled latest one, builds a bounded transcript, and
//          asks the chat's own provider instance for one predicted next user message
//          through the isolated text-generation path. Decisions live in
//          `composerPrediction.ts`.
// Layer: Server service (Beta only; refused on Stable)

import { WsRpcError, type ThreadId, type TurnId } from "@synara/contracts";
import { COMPOSER_PREDICTIONS_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { Cause, Deferred, Duration, Effect, Fiber, Layer, Option, Schema } from "effect";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { COMPOSER_PREDICTION_CONTEXT_BUDGET } from "../../git/textGenerationShared.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildComposerPredictionConversation,
  isComposerPredictionTurnCurrent,
  resolveComposerPredictionRouting,
} from "../composerPrediction.ts";
import {
  ComposerPredictionService,
  type ComposerPredictionServiceShape,
} from "../Services/ComposerPredictionService.ts";

/** A prediction that takes longer than this is no longer worth showing. */
export const COMPOSER_PREDICTION_TIMEOUT = Duration.seconds(20);

/** A generation still running after this long is raced by a second attempt. */
export const COMPOSER_PREDICTION_HEDGE_DELAY = Duration.seconds(6);

interface SharedPrediction {
  readonly result: Deferred.Deferred<string | null>;
  fiber: Fiber.Fiber<void> | undefined;
  waiters: number;
}

const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const layerScope = yield* Effect.scope;
  const pending = new Map<string, SharedPrediction>();

  const readThread = (threadId: ThreadId) =>
    snapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const generateOnce = (threadId: ThreadId, expectedTurnId: TurnId) =>
    Effect.gen(function* () {
      const thread = yield* readThread(threadId);
      if (!thread || !isComposerPredictionTurnCurrent(thread, expectedTurnId)) return null;
      const finalReplyMessageId = thread.latestTurn?.assistantMessageId;
      if (!finalReplyMessageId) return null;

      const routing = resolveComposerPredictionRouting({
        thread,
        settings: yield* serverSettings.getSettings,
      });
      if (!routing) return null;

      const context = yield* snapshotQuery.getThreadMentionContextById(threadId, {
        messageLimit: COMPOSER_PREDICTION_CONTEXT_BUDGET.messageLimit,
      });
      const conversation = Option.isSome(context)
        ? buildComposerPredictionConversation({
            messages: context.value.messages,
            finalReplyMessageId,
          })
        : null;
      if (!conversation) return null;

      const project = yield* snapshotQuery.getProjectShellById(thread.projectId);
      const cwd = Option.isSome(project)
        ? resolveThreadWorkspaceCwd({ thread, projects: [project.value] })
        : undefined;
      const attempt = Effect.suspend(() =>
        textGeneration.generateComposerPrediction({
          cwd: cwd ?? process.cwd(),
          conversation,
          modelSelection: routing.modelSelection,
          ...(routing.providerOptions ? { providerOptions: routing.providerOptions } : {}),
          ...(routing.codexHomePath ? { codexHomePath: routing.codexHomePath } : {}),
        }),
      );
      // A provider backend sometimes stalls for many seconds on a request that normally takes
      // three. A second attempt starts once the usual time has passed; whichever settles first
      // wins and the other is interrupted, so a fast failure still fails fast.
      const generated = yield* Effect.raceFirst(
        attempt,
        Effect.delay(attempt, COMPOSER_PREDICTION_HEDGE_DELAY),
      ).pipe(Effect.timeoutOption(COMPOSER_PREDICTION_TIMEOUT));
      if (Option.isNone(generated)) {
        yield* Effect.logWarning("Composer prediction timed out", { threadId, expectedTurnId });
        return null;
      }

      // The thread may have moved on while the model was thinking.
      if (!isComposerPredictionTurnCurrent(yield* readThread(threadId), expectedTurnId)) {
        return null;
      }
      return generated.value.suggestion;
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        return Effect.logWarning("Composer prediction unavailable", {
          threadId,
          expectedTurnId,
          // Provider detail only; the transcript itself is never logged.
          reason: Schema.is(TextGenerationError)(error) ? error.detail : "unexpected failure",
        }).pipe(Effect.as(null));
      }),
    );

  // One generation per thread and turn. Every caller awaits the same result;
  // the generation is interrupted only once no caller is still waiting.
  const generateShared = (threadId: ThreadId, expectedTurnId: TurnId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = JSON.stringify([threadId, expectedTurnId]);
        let shared = pending.get(key);
        if (!shared) {
          const created: SharedPrediction = {
            result: Deferred.makeUnsafe<string | null>(),
            fiber: undefined,
            waiters: 0,
          };
          pending.set(key, created);
          created.fiber = yield* generateOnce(threadId, expectedTurnId).pipe(
            Effect.onExit((exit) => Deferred.done(created.result, exit)),
            Effect.ensuring(
              Effect.sync(() => {
                if (pending.get(key) === created) pending.delete(key);
              }),
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
    Effect.suspend(() =>
      isServerBetaFeatureEnabled(COMPOSER_PREDICTIONS_BETA_FEATURE)
        ? generateShared(input.threadId, input.expectedTurnId).pipe(
            Effect.map((suggestion) => ({ suggestion })),
          )
        : Effect.fail(
            new WsRpcError({
              message: "Composer suggestions are available in Synara Beta.",
              code: "FEATURE_UNAVAILABLE",
              retryable: false,
            }),
          ),
    );

  return { generate } satisfies ComposerPredictionServiceShape;
});

export const ComposerPredictionServiceLive = Layer.effect(ComposerPredictionService, make);
