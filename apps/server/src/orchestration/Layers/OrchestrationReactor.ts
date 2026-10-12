import { Effect, Layer, Option } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { HubOutputReactor } from "../Services/HubOutputReactor.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const hubOutputReactor = yield* HubOutputReactor;
  const threadGitMetadataReactor = yield* ThreadGitMetadataReactor;
  const sidechatExpiryReactor = yield* SidechatExpiryReactor;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* hubOutputReactor.start;
    yield* checkpointReactor.start;
    yield* threadGitMetadataReactor.start;
    yield* providerRuntimeIngestion.start;
    yield* sidechatExpiryReactor.start;
    // Install every runtime observer before provider command dispatch can
    // begin. Reverse-order finalization then drains provider commands first,
    // side-chat expiry second, runtime ingestion third, Git metadata fourth,
    // checkpoints fifth, and Hub output last.
    yield* providerCommandReactor.start;
  });

  return {
    start,
    reconcileSettledOpenTurns: providerRuntimeIngestion.reconcileSettledOpenTurns,
    drainProviderCommands: providerRuntimeIngestion.drain.pipe(
      Effect.andThen(providerCommandReactor.drain),
      // An existing genuinely uncertain delivery may hold the durable cursor.
      // Preserve that evidence instead of waiting forever for it during quit.
      Effect.timeoutOption("5 seconds"),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.void
          : Effect.logWarning(
              "provider shutdown drain reached its deadline; durable recovery evidence retained",
            ),
      ),
    ),
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
