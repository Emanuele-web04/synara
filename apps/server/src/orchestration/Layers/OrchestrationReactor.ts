import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { StudioOutputReactor } from "../Services/StudioOutputReactor.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const studioOutputReactor = yield* StudioOutputReactor;
  const threadGitMetadataReactor = yield* ThreadGitMetadataReactor;
  const sidechatExpiryReactor = yield* SidechatExpiryReactor;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* studioOutputReactor.start;
    yield* checkpointReactor.start;
    yield* threadGitMetadataReactor.start;
    yield* providerRuntimeIngestion.start;
    yield* sidechatExpiryReactor.start;
    // install every observer before provider dispatch can begin; reverse-order finalization drains commands first, side-chat expiry, ingestion, git metadata, checkpoints, Studio output last
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
