import { Layer } from "effect";

import { GitCoreLive } from "./Layers/GitCore";
import { GitHubCliLive } from "./Layers/GitHubCli";
import { GitManagerLive } from "./Layers/GitManager";
import { GitStatusBroadcasterLive } from "./Layers/GitStatusBroadcaster";
import { CodexTextGenerationServiceLive } from "./Layers/CodexTextGeneration";
import { CursorTextGenerationServiceLive } from "./Layers/CursorTextGeneration";
import { OpenCodeTextGenerationServiceLive } from "./Layers/OpenCodeTextGeneration";
import { ProviderTextGenerationLive } from "./Layers/ProviderTextGeneration";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime";

export const TextGenerationLayerLive = ProviderTextGenerationLive.pipe(
  Layer.provide(CodexTextGenerationServiceLive),
  Layer.provide(CursorTextGenerationServiceLive),
  Layer.provide(OpenCodeTextGenerationServiceLive.pipe(Layer.provide(OpenCodeRuntimeLive))),
);

export const GitManagerLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(TextGenerationLayerLive),
);

export const GitStatusBroadcasterLayerLive = GitStatusBroadcasterLive.pipe(
  Layer.provide(GitManagerLayerLive),
);

export const GitLayerLive = Layer.mergeAll(
  GitCoreLive,
  GitManagerLayerLive,
  GitStatusBroadcasterLayerLive,
);
