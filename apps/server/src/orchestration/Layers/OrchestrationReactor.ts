import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { IdleCompactionReactor } from "../Services/IdleCompactionReactor.ts";
import { HubOutputReactor } from "../Services/HubOutputReactor.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const hubOutputReactor = yield* HubOutputReactor;
  const threadGitMetadataReactor = yield* ThreadGitMetadataReactor;
  const sidechatExpiryReactor = yield* SidechatExpiryReactor;
  const idleCompactionReactor = yield* IdleCompactionReactor;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* hubOutputReactor.start;
    yield* checkpointReactor.start;
    yield* threadGitMetadataReactor.start;
    yield* providerRuntimeIngestion.start;
    yield* sidechatExpiryReactor.start;
    yield* idleCompactionReactor.start;
    // Install every runtime observer before provider command dispatch can
    // begin. Reverse-order finalization then drains provider commands first,
    // idle compaction second, side-chat expiry third, runtime ingestion
    // fourth, Git metadata fifth, checkpoints sixth, and Hub output last.
    yield* providerCommandReactor.start;
  });

  return {
    start,
    reconcileSettledOpenTurns: providerRuntimeIngestion.reconcileSettledOpenTurns,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
