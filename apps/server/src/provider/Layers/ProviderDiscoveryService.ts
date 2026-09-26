import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  ProviderListAgentsInput,
  ProviderListCommandsInput,
  ProviderListModelsInput,
  type ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderModelDescriptor,
  ProviderListSkillsInput,
  type ProviderListSkillsResult,
  ProviderReadPluginInput,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import { Effect, Exit, Layer, Option, Queue, Schema, SchemaIssue } from "effect";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { ServerConfig } from "../../config.ts";
import { gateBetaOnlyProviders, ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import type { ProviderDiscoveryError } from "../Services/ProviderDiscoveryService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import {
  type PersistedModelCatalogEntryInput,
  makeProviderModelDiscoveryCache,
  providerModelDiscoveryCacheKey,
} from "../providerModelDiscoveryCache.ts";
import {
  readProviderModelCatalogCache,
  resolveProviderModelCatalogCachePath,
  writeProviderModelCatalogCache,
} from "../providerModelCatalogCache.ts";
import {
  discoverSkillsCatalog,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
} from "../skillsCatalog.ts";

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

const disabledCapabilitiesForProvider = (
  provider: ProviderComposerCapabilities["provider"],
): ProviderComposerCapabilities => ({
  provider,
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: false,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
});

const decodeProviderModelDescriptorOption = Schema.decodeUnknownOption(ProviderModelDescriptor);

function isolateMalformedModelDescriptors(input: {
  readonly provider: ProviderListModelsInput["provider"];
  readonly result: ProviderListModelsResult;
}): Effect.Effect<ProviderListModelsResult> {
  const models = input.result.models.flatMap((model) => {
    const decoded = decodeProviderModelDescriptorOption(model);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const omittedCount = input.result.models.length - models.length;
  if (omittedCount === 0) {
    return Effect.succeed(input.result);
  }
  return Effect.logWarning("provider model discovery omitted malformed descriptors", {
    provider: input.provider,
    source: input.result.source ?? "unknown",
    omittedCount,
  }).pipe(
    Effect.as({
      ...input.result,
      models,
    }),
  );
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  // One catalog cache for every provider: adapters that spawn a CLI/ACP process
  // per listModels call share stale-while-revalidate, single-flight, and
  // failure-replay behaviour with adapters that reuse a running process.
  // Snapshots persist to stateDir so a restart reopens the picker with
  // last-known models instead of a fresh discovery wait.
  const catalogCachePath = resolveProviderModelCatalogCachePath({
    stateDir: serverConfig.stateDir,
  });
  const persistedCatalogs = yield* readProviderModelCatalogCache(catalogCachePath);
  // Writes serialize through a queue so concurrent cache mutations can't race
  // the atomic file write.
  const catalogWriteQueue =
    yield* Queue.unbounded<ReadonlyArray<PersistedModelCatalogEntryInput>>();
  const writeCatalogSnapshot = (entries: ReadonlyArray<PersistedModelCatalogEntryInput>) =>
    writeProviderModelCatalogCache({ filePath: catalogCachePath, entries }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist provider model catalogs", {
          path: catalogCachePath,
          issues: cause.toString(),
        }),
      ),
    );
  // Registered before the writer fiber: finalizers run LIFO, so at scope close
  // the writer is interrupted first and this then drains anything still queued.
  // The newest snapshot always reaches disk even on shutdown.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      // Queue.takeAll would block on an empty queue; takeUnsafe drains
      // synchronously so the newest queued snapshot wins.
      let latest: ReadonlyArray<PersistedModelCatalogEntryInput> | undefined;
      for (
        let taken = Queue.takeUnsafe(catalogWriteQueue);
        taken !== undefined;
        taken = Queue.takeUnsafe(catalogWriteQueue)
      ) {
        if (Exit.isSuccess(taken)) latest = taken.value;
      }
      return latest === undefined ? Effect.void : writeCatalogSnapshot(latest);
    }),
  );
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(catalogWriteQueue), (first) => {
        // Coalesce bursts: each queued item is a full snapshot, so drain to the
        // newest before writing (e.g. several providers discovered at boot).
        let latest = first;
        for (
          let taken = Queue.takeUnsafe(catalogWriteQueue);
          taken !== undefined;
          taken = Queue.takeUnsafe(catalogWriteQueue)
        ) {
          if (Exit.isSuccess(taken)) latest = taken.value;
        }
        return writeCatalogSnapshot(latest);
      }),
    ),
  );
  const modelDiscoveryCache = makeProviderModelDiscoveryCache<ProviderDiscoveryError>({
    persistedCatalogs,
    onCatalogsChanged: (entries) => {
      Queue.offerUnsafe(catalogWriteQueue, entries);
    },
  });
  const providerIsEnabled = Effect.fn("providerIsEnabled")(function* (
    provider: ProviderGetComposerCapabilitiesInput["provider"],
  ) {
    return yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers[provider].enabled),
      Effect.orElseSucceed(() => isServerBetaFeatureEnabled(provider)),
    );
  });

  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.getComposerCapabilities",
        schema: ProviderGetComposerCapabilitiesInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return disabledCapabilitiesForProvider(parsed.provider);
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      const capabilities = adapter.getComposerCapabilities
        ? yield* adapter.getComposerCapabilities()
        : disabledCapabilitiesForProvider(parsed.provider);
      // The unified Synara skills catalog backs skill discovery for every
      // provider, including ones without native skill support.
      return {
        ...capabilities,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
      };
    });

  const listSkills: ProviderDiscoveryServiceShape["listSkills"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listSkills",
        schema: ProviderListSkillsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          skills: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      const nativeResult: ProviderListSkillsResult | null = adapter.listSkills
        ? yield* adapter
            .listSkills(parsed)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "provider-native skill discovery failed; serving the Synara skills catalog only",
                  { provider: parsed.provider, error },
                ).pipe(Effect.as(null)),
              ),
            )
        : null;
      const catalogSkills = yield* Effect.tryPromise(() =>
        discoverSkillsCatalog({
          cwd: parsed.cwd,
          homeDir: serverConfig.homeDir,
          synaraBaseDir: serverConfig.baseDir,
          provider: parsed.provider,
          ...(parsed.forceReload !== undefined ? { forceReload: parsed.forceReload } : {}),
          ...(parsed.agentDir !== undefined ? { agentDir: parsed.agentDir } : undefined),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("synara skills catalog discovery failed", {
            provider: parsed.provider,
            cause,
          }).pipe(Effect.as([] as ProviderSkillDescriptor[])),
        ),
      );
      const merged = mergeSkillsIntoCatalog({
        native: nativeResult?.skills ?? [],
        catalog: catalogSkills,
      });
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
      );
      return {
        skills: filterDisabledSkills(merged, settings.skills.disabled),
        source: nativeResult?.source ? `${nativeResult.source}+synara.catalog` : "synara.catalog",
        cached: nativeResult?.cached ?? false,
      } satisfies ProviderListSkillsResult;
    });

  const listCommands: ProviderDiscoveryServiceShape["listCommands"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listCommands",
        schema: ProviderListCommandsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          commands: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listCommands) {
        return {
          commands: [],
          source: "unsupported",
          cached: false,
        };
      }
      if (parsed.provider !== "claudeAgent") {
        return yield* adapter.listCommands(parsed);
      }
      // Server-owned like the session start options, so discovery lists the
      // same commands a new Claude session will actually have.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
      );
      return yield* adapter.listCommands({
        ...parsed,
        enableArtifacts: settings.providers.claudeAgent.enableArtifacts,
      });
    });

  const listPlugins: ProviderDiscoveryServiceShape["listPlugins"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listPlugins",
        schema: ProviderListPluginsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listPlugins) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listPlugins(parsed);
    });

  const readPlugin: ProviderDiscoveryServiceShape["readPlugin"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.readPlugin",
        schema: ProviderReadPluginInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Provider '${parsed.provider}' is disabled in Synara settings.`,
        });
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.readPlugin) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Plugin discovery is unavailable for provider '${parsed.provider}'.`,
        });
      }
      return yield* adapter.readPlugin(parsed);
    });

  const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listModels",
        schema: ProviderListModelsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          models: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listModels) {
        return {
          models: [],
          source: "unsupported",
          cached: false,
        };
      }
      const listModelsFromAdapter = adapter.listModels;
      const discover = Effect.suspend(() => listModelsFromAdapter(parsed)).pipe(
        Effect.flatMap((result) =>
          isolateMalformedModelDescriptors({ provider: parsed.provider, result }),
        ),
      );
      // OMP discovery is a cheap `omp models` subprocess call, so bypass the
      // shared cache and always read the live catalog. A shared fresh window
      // would freeze catalog edits for up to 30 minutes and persist them
      // across restarts.
      if (parsed.provider === "omp") {
        return yield* discover;
      }
      return yield* modelDiscoveryCache.lookup(providerModelDiscoveryCacheKey(parsed), discover);
    });

  const listAgents: ProviderDiscoveryServiceShape["listAgents"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listAgents",
        schema: ProviderListAgentsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          agents: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listAgents) {
        return {
          agents: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listAgents(parsed);
    });

  return {
    getComposerCapabilities,
    listCommands,
    listSkills,
    listPlugins,
    readPlugin,
    listModels,
    listAgents,
  } satisfies ProviderDiscoveryServiceShape;
});

export const ProviderDiscoveryServiceLive = Layer.effect(ProviderDiscoveryService, make);
