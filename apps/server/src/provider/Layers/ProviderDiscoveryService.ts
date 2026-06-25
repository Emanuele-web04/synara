import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  type ProviderKind,
  ProviderListAgentsInput,
  ProviderListCommandsInput,
  ProviderListModelsInput,
  type ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderModelDescriptor,
  ProviderListSkillsInput,
  type ProviderListSkillsResult,
  ProviderReadPluginInput,
  type ProviderStartOptions,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import {
  providerStartOptionsFromInstance,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { Effect, Exit, Layer, Option, Queue, Schema, SchemaIssue } from "effect";

import { ServerConfig } from "../../config.ts";
import { gateBetaOnlyProviders, ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import type { ProviderDiscoveryError } from "../Services/ProviderDiscoveryService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderHealth } from "../Services/ProviderHealth.ts";
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

const PROVIDER_DISCOVERY_OPTION_KEYS = {
  codex: ["binaryPath", "homePath", "shadowHomePath", "accountId"],
  claudeAgent: ["binaryPath", "homePath"],
  cursor: ["binaryPath", "apiEndpoint"],
  devin: ["binaryPath"],
  antigravity: ["binaryPath"],
  grok: ["binaryPath"],
  droid: ["binaryPath"],
  opencode: ["binaryPath", "serverUrl", "experimentalWebSockets"],
  pi: ["binaryPath", "agentDir"],
  omp: ["binaryPath", "agentDir"],
} as const satisfies Record<ProviderKind, readonly string[]>;

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerHealth = yield* ProviderHealth;
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
  const applyProviderStartOptions = <T extends { readonly provider: ProviderKind }>(
    parsed: T,
    providerOptions: ProviderStartOptions | undefined,
    replaceProviderOptions: boolean,
  ): T => {
    const base = { ...parsed } as Record<string, unknown>;
    if (replaceProviderOptions) {
      for (const key of PROVIDER_DISCOVERY_OPTION_KEYS[parsed.provider]) {
        delete base[key];
      }
    }
    const providerConfig = providerOptions?.[parsed.provider];
    if (!providerConfig || typeof providerConfig !== "object") {
      return base as T;
    }
    const overlay = Object.fromEntries(
      Object.entries(providerConfig).filter(([, value]) => value !== undefined && value !== ""),
    );
    return { ...base, ...overlay } as T;
  };

  const resolveDiscoveryInput = <
    T extends { readonly provider: ProviderKind; readonly instanceId?: string | undefined },
  >(
    parsed: T,
  ): Effect.Effect<
    T & { readonly provider: ProviderKind; readonly instanceId: string; readonly enabled: boolean },
    ProviderValidationError,
    never
  > =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
      );
      const instance = resolveProviderInstance(settings, {
        provider: parsed.provider,
        ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
      });
      if (!instance) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.resolveDiscoveryInput",
          issue: `Unknown provider instance '${parsed.instanceId}'.`,
        });
      }
      if (parsed.provider !== instance.driver) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.resolveDiscoveryInput",
          issue: `Requested provider '${parsed.provider}' does not match provider instance '${instance.instanceId}' driver '${instance.driver}'.`,
        });
      }
      const resolved = {
        ...parsed,
        provider: instance.driver as ProviderKind,
        instanceId: instance.instanceId,
        enabled: instance.enabled,
      } as T & {
        readonly provider: ProviderKind;
        readonly instanceId: string;
        readonly enabled: boolean;
      };
      return applyProviderStartOptions(
        resolved,
        providerStartOptionsFromInstance(instance),
        parsed.instanceId !== undefined,
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
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return disabledCapabilitiesForProvider(resolved.provider);
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      const capabilities = adapter.getComposerCapabilities
        ? yield* adapter.getComposerCapabilities()
        : disabledCapabilitiesForProvider(resolved.provider);
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
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return {
          skills: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      const nativeResult: ProviderListSkillsResult | null = adapter.listSkills
        ? yield* adapter
            .listSkills(resolved)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "provider-native skill discovery failed; serving the Synara skills catalog only",
                  { provider: resolved.provider, error },
                ).pipe(Effect.as(null)),
              ),
            )
        : null;
      const catalogSkills = yield* Effect.tryPromise(() =>
        discoverSkillsCatalog({
          cwd: parsed.cwd,
          homeDir: serverConfig.homeDir,
          synaraBaseDir: serverConfig.baseDir,
          provider: resolved.provider,
          ...(parsed.forceReload !== undefined ? { forceReload: parsed.forceReload } : {}),
          ...(parsed.agentDir !== undefined ? { agentDir: parsed.agentDir } : undefined),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("synara skills catalog discovery failed", {
            provider: resolved.provider,
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
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return {
          commands: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      if (!adapter.listCommands) {
        return {
          commands: [],
          source: "unsupported",
          cached: false,
        };
      }
      if (resolved.provider !== "claudeAgent") {
        return yield* adapter.listCommands(resolved);
      }
      // Server-owned like the session start options, so discovery lists the
      // same commands a new Claude session will actually have.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => gateBetaOnlyProviders(DEFAULT_SERVER_SETTINGS)),
      );
      return yield* adapter.listCommands({
        ...resolved,
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
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
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
      return yield* adapter.listPlugins(resolved);
    });

  const readPlugin: ProviderDiscoveryServiceShape["readPlugin"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.readPlugin",
        schema: ProviderReadPluginInput,
        payload: input,
      });
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Provider instance '${resolved.instanceId}' is disabled in Synara settings.`,
        });
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      if (!adapter.readPlugin) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Plugin discovery is unavailable for provider '${resolved.provider}'.`,
        });
      }
      return yield* adapter.readPlugin(resolved);
    });

  const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listModels",
        schema: ProviderListModelsInput,
        payload: input,
      });
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return {
          models: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      if (!adapter.listModels) {
        return {
          models: [],
          source: "unsupported",
          cached: false,
        };
      }
      const listModelsFromAdapter = adapter.listModels;
      const discover = Effect.suspend(() => listModelsFromAdapter(resolved)).pipe(
        Effect.flatMap((result) =>
          isolateMalformedModelDescriptors({ provider: resolved.provider, result }),
        ),
      );
      // OMP re-resolves file-backed modelRoles per request, so a shared fresh
      // window would freeze role/config edits for up to 30 minutes and persist
      // them across restarts. `omp models` is a cheap subprocess — bypass the
      // shared cache so every picker read reflects the live catalog.
      if (resolved.provider === "omp") {
        return yield* discover;
      }
      const cacheKey = providerModelDiscoveryCacheKey(resolved);
      const runtimeVersion =
        resolved.provider === "claudeAgent"
          ? ((yield* providerHealth.getStatuses).find((status) => status.provider === "claudeAgent" && status.instanceId === resolved.instanceId)
              ?.version ?? null)
          : undefined;
      return yield* modelDiscoveryCache.lookup(
        { ...cacheKey, ...(runtimeVersion !== undefined ? { runtimeVersion } : {}) },
        discover,
      );
    });

  const listAgents: ProviderDiscoveryServiceShape["listAgents"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listAgents",
        schema: ProviderListAgentsInput,
        payload: input,
      });
      const resolved = yield* resolveDiscoveryInput(parsed);
      if (!resolved.enabled) {
        return {
          agents: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(resolved.provider);
      if (!adapter.listAgents) {
        return {
          agents: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listAgents(resolved);
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
