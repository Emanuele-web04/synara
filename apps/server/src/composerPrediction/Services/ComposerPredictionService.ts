import type {
  ServerGenerateComposerPredictionInput,
  ServerGenerateComposerPredictionResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * Composer predictions: one predicted next user message for a
 * thread's settled latest turn, generated through the isolated text-generation
 * path on the chat's own provider instance.
 */
export interface ComposerPredictionServiceShape {
  /**
   * A stale turn, an unavailable provider, a timeout, or invalid output all return
   * `suggestion: null`. Concurrent calls for the same thread and turn share one
   * generation, which is interrupted once every caller has stopped waiting. It starts
   * after a short delay, so a caller that stops waiting sooner starts no provider
   * process, and the model's answer is reused for later calls about the same turn.
   */
  readonly generate: (
    input: ServerGenerateComposerPredictionInput,
  ) => Effect.Effect<ServerGenerateComposerPredictionResult>;
}

export class ComposerPredictionService extends ServiceMap.Service<
  ComposerPredictionService,
  ComposerPredictionServiceShape
>()("synara/composerPrediction/Services/ComposerPredictionService") {}
