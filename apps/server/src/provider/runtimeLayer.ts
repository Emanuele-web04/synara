import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentGatewayCredentialsWithSecretsLive } from "../agentGateway/Layers/AgentGatewayCredentials";
import { ServerConfig } from "../config";
import { ServerSettingsLive } from "../serverSettings";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService";
import { ProviderUnsupportedError } from "./Errors";
import { makeClaudeAdapterLive } from "./Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./Layers/CodexAdapter";
import { makeCursorAdapterLive } from "./Layers/CursorAdapter";
import { makeEventNdjsonLogger } from "./Layers/EventNdjsonLogger";
import { makeGeminiAdapterLive } from "./Layers/GeminiAdapter";
import { makeDroidAdapterLive } from "./Layers/DroidAdapter";
import { makeGrokAdapterLive } from "./Layers/GrokAdapter";
import { makeKiloAdapterLive, makeOpenCodeAdapterLive } from "./Layers/OpenCodeAdapter";
import { makePiAdapterLive } from "./Layers/PiAdapter";
import { ProviderAdapterRegistryLive } from "./Layers/ProviderAdapterRegistry";
import { ProviderDiscoveryServiceLive } from "./Layers/ProviderDiscoveryService";
import { makeProviderServiceLive } from "./Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory";
import { ProviderAdapterRegistry } from "./Services/ProviderAdapterRegistry";
import { ProviderDiscoveryService } from "./Services/ProviderDiscoveryService";
import { ProviderService } from "./Services/ProviderService";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";

export function makeServerProviderLayer(
  options: {
    readonly agentGatewayCredentialsLayer?: typeof AgentGatewayCredentialsWithSecretsLive;
  } = {},
): Layer.Layer<
  ProviderService | ProviderDiscoveryService | ProviderAdapterRegistry | ProviderSessionDirectory,
  ProviderUnsupportedError,
  | SqlClient.SqlClient
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | AnalyticsService
  | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const { logProviderEvents, providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "native",
        })
      : undefined;
    const canonicalEventLogger = logProviderEvents
      ? yield* makeEventNdjsonLogger(providerEventLogPath, {
          stream: "canonical",
        })
      : undefined;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    // Gives sessions their synara_* MCP tool credentials. OpenCode/Kilo are
    // excluded for now: their server processes are pooled across threads, so a
    // per-thread bearer token cannot be attached to the shared server config.
    // Pi has no MCP client support.
    const agentGatewayCredentialsLayer =
      options.agentGatewayCredentialsLayer ?? AgentGatewayCredentialsWithSecretsLive;
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const openCodeAdapterLayer = makeOpenCodeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const kiloAdapterLayer = makeKiloAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const geminiAdapterLayer = makeGeminiAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const grokAdapterLayer = makeGrokAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const droidAdapterLayer = makeDroidAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const cursorAdapterLayer = makeCursorAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    ).pipe(Layer.provide(agentGatewayCredentialsLayer));
    const piAdapterLayer = makePiAdapterLive(nativeEventLogger ? { nativeEventLogger } : undefined);
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provide(cursorAdapterLayer),
      Layer.provide(geminiAdapterLayer),
      Layer.provide(grokAdapterLayer),
      Layer.provide(droidAdapterLayer),
      Layer.provide(kiloAdapterLayer),
      Layer.provide(openCodeAdapterLayer),
      Layer.provide(piAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
    const providerDiscoveryLayer = ProviderDiscoveryServiceLive.pipe(
      Layer.provide(adapterRegistryLayer),
      // Skill toggles live in server settings; the shared ServerSettingsLive
      // layer is memoized so this reuses the instance built at the top level.
      Layer.provide(ServerSettingsLive),
    );
    return Layer.mergeAll(
      providerServiceLayer,
      providerDiscoveryLayer,
      adapterRegistryLayer,
      providerSessionDirectoryLayer,
    );
  }).pipe(Layer.unwrap);
}
