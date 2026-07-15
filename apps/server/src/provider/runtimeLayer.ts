import { Effect, Layer } from "effect";

import { ServerConfig } from "../config";
import {
  makeProviderServerPasswordResolver,
  ProviderCredentials,
  ProviderCredentialsLive,
} from "../providerCredentials";
import { ServerSettingsLive } from "../serverSettings";
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
import { makeDurableProviderServiceLive } from "./Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ProviderRuntimeEventRepositoryLive } from "../persistence/Layers/ProviderRuntimeEvents";

export function makeServerProviderLayer() {
  return Effect.gen(function* () {
    const credentials = yield* ProviderCredentials;
    const resolveProviderServerPassword = makeProviderServerPasswordResolver(credentials);
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
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const openCodeAdapterLayer = makeOpenCodeAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      resolveServerPassword: resolveProviderServerPassword,
    });
    const kiloAdapterLayer = makeKiloAdapterLive({
      ...(nativeEventLogger ? { nativeEventLogger } : {}),
      resolveServerPassword: resolveProviderServerPassword,
    });
    const geminiAdapterLayer = makeGeminiAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const grokAdapterLayer = makeGrokAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const droidAdapterLayer = makeDroidAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const cursorAdapterLayer = makeCursorAdapterLive(
      {},
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
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
    const providerServiceLayer = makeDurableProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(ProviderRuntimeEventRepositoryLive),
    );
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
  }).pipe(Effect.provide(ProviderCredentialsLive.pipe(Layer.orDie)), Layer.unwrap);
}
