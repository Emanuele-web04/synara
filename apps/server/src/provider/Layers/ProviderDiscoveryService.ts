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
import { Effect, Layer, Option, Schema, SchemaIssue } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import type { ProviderDiscoveryError } from "../Services/ProviderDiscoveryService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import {
  makeProviderModelDiscoveryCache,
  providerModelDiscoveryCacheKey,
} from "../providerModelDiscoveryCache.ts";
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
  // per listModels call (cursor, grok, antigravity, opencode, pi) get the same
  // stale-while-revalidate, single-flight, and failure-replay behaviour that
  // codex/claude implement privately.
  const modelDiscoveryCache = makeProviderModelDiscoveryCache<ProviderDiscoveryError>();
  const applyProviderStartOptions = <T extends { readonly provider: ProviderKind }>(
    parsed: T,
    providerOptions: ProviderStartOptions | undefined,
  ): T => {
    const providerConfig = providerOptions?.[parsed.provider];
    if (!providerConfig || typeof providerConfig !== "object") {
      return parsed;
    }
    const overlay = Object.fromEntries(
      Object.entries(providerConfig).filter(([, value]) => value !== undefined && value !== ""),
    );
    return { ...parsed, ...overlay } as T;
  };

  const resolveDiscoveryInput = <
    T extends { readonly provider: ProviderKind; readonly instanceId?: string | undefined },
  >(
    parsed: T,
  ): Effect.Effect<
    T & { readonly provider: ProviderKind; readonly instanceId: string; readonly enabled: boolean },
    never,
    never
  > =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      const instance = resolveProviderInstance(settings, {
        provider: parsed.provider,
        ...(parsed.instanceId ? { instanceId: parsed.instanceId } : {}),
      });
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
      return applyProviderStartOptions(resolved, providerStartOptionsFromInstance(instance));
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
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
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
      return yield* adapter.listCommands(resolved);
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
      return yield* modelDiscoveryCache.lookup(
        providerModelDiscoveryCacheKey(resolved),
        // Suspend so the adapter is only touched when the cache actually misses.
        Effect.suspend(() => listModelsFromAdapter(resolved)).pipe(
          Effect.flatMap((result) =>
            isolateMalformedModelDescriptors({ provider: resolved.provider, result }),
          ),
        ),
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
