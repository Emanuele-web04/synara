import { Layer } from "effect";

import { GitCoreLive } from "./Layers/GitCore";
import { GitHubCliLive } from "./Layers/GitHubCli";
import { GitManagerLive } from "./Layers/GitManager";
import { GitStatusBroadcasterLive } from "./Layers/GitStatusBroadcaster";
import { CodexTextGenerationServiceLive } from "./Layers/CodexTextGeneration";
import { CursorTextGenerationServiceLive } from "./Layers/CursorTextGeneration";
import {
  makeKiloTextGenerationServiceLive,
  makeOpenCodeTextGenerationServiceLive,
} from "./Layers/OpenCodeTextGeneration";
import { ProviderTextGenerationLive } from "./Layers/ProviderTextGeneration";
import { OpenCodeRuntimeLive } from "../provider/opencodeRuntime";
import {
  ProviderCredentialsLive,
  resolveProviderServerPassword,
} from "../providerCredentials";

const kiloTextGenerationLayer = makeKiloTextGenerationServiceLive(
  resolveProviderServerPassword,
).pipe(Layer.provide(OpenCodeRuntimeLive), Layer.provide(ProviderCredentialsLive));
const openCodeTextGenerationLayer = makeOpenCodeTextGenerationServiceLive(
  resolveProviderServerPassword,
).pipe(Layer.provide(OpenCodeRuntimeLive), Layer.provide(ProviderCredentialsLive));

export const TextGenerationLayerLive = ProviderTextGenerationLive.pipe(
  Layer.provide(CodexTextGenerationServiceLive),
  Layer.provide(CursorTextGenerationServiceLive),
  Layer.provide(kiloTextGenerationLayer),
  Layer.provide(openCodeTextGenerationLayer),
);

export const GitManagerLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(TextGenerationLayerLive),
);

export const GitStatusBroadcasterLayerLive = GitStatusBroadcasterLive.pipe(
  Layer.provide(Layer.mergeAll(GitCoreLive, GitManagerLayerLive)),
);

export const GitLayerLive = Layer.mergeAll(
  GitCoreLive,
  GitHubCliLive,
  GitManagerLayerLive,
  GitStatusBroadcasterLayerLive,
);
