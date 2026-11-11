import type {
  ServerGenerateComposerPredictionInput,
  ServerGenerateComposerPredictionResult,
  WsRpcError,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * Composer predictions (Beta only): one predicted next user message for a
 * thread's settled latest turn, generated through the isolated text-generation
 * path on the chat's own provider instance.
 */
export interface ComposerPredictionServiceShape {
  /**
   * Fails only when the Beta feature is off on this host. A stale turn, an
   * unavailable provider, a timeout, or invalid output all return
   * `suggestion: null`. Concurrent calls for the same thread and turn share one
   * generation, which is interrupted once every caller has stopped waiting.
   */
  readonly generate: (
    input: ServerGenerateComposerPredictionInput,
  ) => Effect.Effect<ServerGenerateComposerPredictionResult, WsRpcError>;
}

export class ComposerPredictionService extends ServiceMap.Service<
  ComposerPredictionService,
  ComposerPredictionServiceShape
>()("synara/composerPrediction/Services/ComposerPredictionService") {}
