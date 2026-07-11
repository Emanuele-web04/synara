/**
 * ServerSettings - Server-authoritative settings persistence.
 *
 * Owns settings that affect server-side behavior. The web app can continue to
 * keep UI-only preferences in local storage while these values become durable
 * and process-authoritative on the server.
 */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderKind,
  type ProviderWithDefaultModel,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { deepMerge, type DeepPartial } from "@synara/shared/Struct";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
  resolveModelSelectionInstanceId,
} from "@synara/shared/providerInstances";
import { applyServerSettingsPatch } from "@synara/shared/serverSettings";
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { ServerConfig } from "./config";

export interface ServerSettingsShape {
  readonly start: Effect.Effect<void, ServerSettingsError>;
  readonly ready: Effect.Effect<void, ServerSettingsError>;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("synara/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const initialSettings = yield* normalizeSettings(
          "<memory>",
          DEFAULT_SERVER_SETTINGS,
          overrides as ServerSettingsPatch,
        );
        const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
        const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
        const emitChange = (settings: ServerSettings) =>
          PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.flatMap((currentSettings) =>
                normalizeSettings("<memory>", currentSettings, patch),
              ),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
              Effect.tap(emitChange),
              Effect.map(resolveTextGenerationProvider),
            ),
          get streamChanges() {
            return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
          },
        } satisfies ServerSettingsShape;
      }),
    );
}

// Fallback order for the git-writing/title/recap model. Must only contain
// drivers ProviderTextGeneration actually implements (see
// implementationForDriver): Gemini/Grok/Pi are rejected by that router, so
// falling back to them would fail every generation instead of moving on.
const PROVIDER_ORDER: readonly ProviderWithDefaultModel[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "kilo",
  "opencode",
];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

function providerConfigSecretName(input: {
  readonly instanceId: string;
  readonly key: string;
}): string {
  return `provider-config-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.key, "utf8").toString("base64url")}`;
}

type LegacyServerPasswordProvider = "kilo" | "opencode";

const LEGACY_SERVER_PASSWORD_PROVIDERS = [
  "kilo",
  "opencode",
] as const satisfies readonly LegacyServerPasswordProvider[];

function legacyProviderConfigSecretName(input: {
  readonly provider: LegacyServerPasswordProvider;
  readonly key: "serverPassword";
}): string {
  return `legacy-provider-config-${input.provider}-${input.key}`;
}

function newVersionedSecretReference(): string {
  return `provider-secret-v2-${randomUUID()}`;
}

function providerConfigSecretReferenceKey(key: string): string {
  return `${key}SecretRef`;
}

function defaultTextGenerationModel(provider: ProviderKind): string {
  return provider === "pi" ? "openai/gpt-5.5" : DEFAULT_MODEL_BY_PROVIDER[provider];
}

function isTextGenerationSelectionEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return findTextGenerationSelectionInstance(settings, selection)?.enabled === true;
}

function findTextGenerationSelectionInstance(
  settings: ServerSettings,
  selection: ModelSelection,
): ResolvedProviderInstance | undefined {
  const selectionInstanceId = resolveModelSelectionInstanceId(selection);
  return deriveProviderInstances(settings).find(
    (candidate) => candidate.instanceId === selectionInstanceId,
  );
}

function findFallbackTextGenerationInstance(settings: ServerSettings) {
  const instances = deriveProviderInstances(settings);
  for (const provider of PROVIDER_ORDER) {
    const instance = instances.find(
      (candidate) => candidate.enabled && candidate.driver === provider,
    );
    if (instance) {
      return instance;
    }
  }
  return null;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  const selectedInstance = findTextGenerationSelectionInstance(settings, selection);
  if (selectedInstance?.enabled) {
    return selectedInstance.instanceId === selection.instanceId
      ? settings
      : {
          ...settings,
          textGenerationModelSelection: {
            instanceId: selectedInstance.instanceId,
            model: selection.model,
          } as ModelSelection,
        };
  }
  if (isTextGenerationSelectionEnabled(settings, selection)) {
    return settings;
  }

  const fallback = findFallbackTextGenerationInstance(settings);
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: fallback.instanceId,
      model: defaultTextGenerationModel(fallback.driver),
    } as ModelSelection,
  };
}

function environmentByName(
  entries: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
): ReadonlyMap<string, ProviderInstanceEnvironmentVariable> {
  const byName = new Map<string, ProviderInstanceEnvironmentVariable>();
  for (const entry of entries ?? []) {
    byName.set(entry.name.trim(), entry);
  }
  return byName;
}

const SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS = new Set(["serverPassword"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type PersistedSecretReferences = ReadonlyMap<string, string>;

// Capture the exact physical names referenced by the durable settings file.
// Missing refs are legacy markers whose logical name was also the store key.
function collectPersistedSecretReferences(settings: ServerSettings): PersistedSecretReferences {
  const references = new Map<string, string>();
  for (const provider of LEGACY_SERVER_PASSWORD_PROVIDERS) {
    const providerSettings = settings.providers[provider];
    if (providerSettings.serverPasswordRedacted !== true) continue;
    const logicalName = legacyProviderConfigSecretName({ provider, key: "serverPassword" });
    references.set(logicalName, providerSettings.serverPasswordSecretRef ?? logicalName);
  }
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    for (const variable of instance.environment ?? []) {
      if (!variable.sensitive || variable.valueRedacted !== true) continue;
      const logicalName = providerEnvironmentSecretName({ instanceId, name: variable.name });
      references.set(logicalName, variable.valueSecretRef ?? logicalName);
    }
    if (!isRecord(instance.config)) continue;
    for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
      if (instance.config[`${key}Redacted`] !== true) continue;
      const logicalName = providerConfigSecretName({ instanceId, key });
      const configuredReference = instance.config[providerConfigSecretReferenceKey(key)];
      references.set(
        logicalName,
        typeof configuredReference === "string" && configuredReference.length > 0
          ? configuredReference
          : logicalName,
      );
    }
  }
  return references;
}

function preserveRedactedProviderInstanceConfig(
  currentConfig: unknown,
  nextConfig: unknown,
): unknown {
  if (!isRecord(currentConfig) || !isRecord(nextConfig)) {
    return nextConfig;
  }

  let didChange = false;
  const restored: Record<string, unknown> = { ...nextConfig };
  for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
    const markerKey = `${key}Redacted`;
    const referenceKey = providerConfigSecretReferenceKey(key);
    if (referenceKey in restored) {
      delete restored[referenceKey];
      didChange = true;
    }
    if (nextConfig[markerKey] !== true) {
      continue;
    }
    const currentValue = currentConfig[key];
    if (typeof currentValue !== "string" || currentValue.length === 0) {
      continue;
    }
    restored[key] = currentValue;
    delete restored[markerKey];
    didChange = true;
  }

  return didChange ? restored : nextConfig;
}

function preserveRedactedProviderInstanceEnvironment(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (patch.providerInstances === undefined) {
    return patch;
  }

  const providerInstances: Record<
    string,
    NonNullable<ServerSettingsPatch["providerInstances"]>[string]
  > = {};
  for (const [instanceId, nextInstance] of Object.entries(patch.providerInstances)) {
    const currentEnvironment = environmentByName(
      current.providerInstances[instanceId]?.environment,
    );
    const nextEnvironment = nextInstance.environment?.map((entry) => {
      const { valueSecretRef: _valueSecretRef, ...entryWithoutReference } = entry;
      if (entryWithoutReference.valueRedacted !== true) {
        return entryWithoutReference;
      }
      const currentEntry = currentEnvironment.get(entry.name.trim());
      if (
        !currentEntry ||
        typeof currentEntry.value !== "string" ||
        currentEntry.value.length === 0
      ) {
        return entryWithoutReference;
      }
      const { valueRedacted: _valueRedacted, ...unredactedEntry } = entryWithoutReference;
      return {
        ...unredactedEntry,
        sensitive: entry.sensitive || currentEntry.sensitive,
        value: currentEntry.value,
      };
    });
    const nextConfig =
      nextInstance.config === undefined
        ? undefined
        : preserveRedactedProviderInstanceConfig(
            current.providerInstances[instanceId]?.config,
            nextInstance.config,
          );
    providerInstances[instanceId] = {
      ...nextInstance,
      ...(nextEnvironment !== undefined ? { environment: nextEnvironment } : {}),
      ...(nextConfig !== undefined ? { config: nextConfig } : {}),
    };
  }

  return {
    ...patch,
    providerInstances: providerInstances as NonNullable<ServerSettingsPatch["providerInstances"]>,
  };
}

function preserveRedactedLegacyServerPasswords(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  if (patch.providers === undefined) {
    return patch;
  }

  let providers: NonNullable<ServerSettingsPatch["providers"]> | undefined;
  for (const provider of LEGACY_SERVER_PASSWORD_PROVIDERS) {
    const nextProviderSettings = patch.providers[provider];
    if (nextProviderSettings?.serverPasswordRedacted !== true) {
      continue;
    }
    const currentPassword = current.providers[provider].serverPassword;
    if (!currentPassword) {
      continue;
    }

    const { serverPasswordRedacted: _serverPasswordRedacted, ...restoredProviderSettings } =
      nextProviderSettings;
    providers = {
      ...(providers ?? patch.providers),
      [provider]: {
        ...restoredProviderSettings,
        serverPassword: currentPassword,
      },
    };
  }

  return providers ? { ...patch, providers } : patch;
}

function redactProviderInstanceConfig(config: unknown): unknown {
  if (!isRecord(config)) {
    return config;
  }

  let didRedact = false;
  const redacted: Record<string, unknown> = { ...config };
  for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
    const referenceKey = providerConfigSecretReferenceKey(key);
    if (referenceKey in redacted) {
      delete redacted[referenceKey];
      didRedact = true;
    }
    const value = config[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    redacted[key] = "";
    redacted[`${key}Redacted`] = true;
    didRedact = true;
  }

  return didRedact ? redacted : config;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  const { valueSecretRef: _valueSecretRef, ...variableWithoutReference } = variable;
  if (!variable.sensitive) {
    const { valueRedacted: _valueRedacted, ...rest } = variableWithoutReference;
    return rest;
  }
  return {
    ...variableWithoutReference,
    value: "",
    ...((variable.value ?? "").length > 0 || variable.valueRedacted === true
      ? { valueRedacted: true }
      : {}),
  };
}

function redactLegacyServerPasswordProvider<
  T extends {
    readonly serverPassword: string;
    readonly serverPasswordRedacted?: boolean;
    readonly serverPasswordSecretRef?: string;
  },
>(provider: T): T {
  const { serverPasswordSecretRef: _serverPasswordSecretRef, ...providerWithoutReference } =
    provider;
  if (!provider.serverPassword) {
    return providerWithoutReference as T;
  }
  return {
    ...providerWithoutReference,
    serverPassword: "",
    serverPasswordRedacted: true,
  } as T;
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      {
        ...instance,
        ...(instance.config !== undefined
          ? { config: redactProviderInstanceConfig(instance.config) }
          : {}),
        ...(instance.environment
          ? {
              environment: instance.environment.map(redactProviderEnvironmentVariable),
            }
          : {}),
      },
    ]),
  );
  return {
    ...settings,
    providers: {
      ...settings.providers,
      kilo: redactLegacyServerPasswordProvider(settings.providers.kilo),
      opencode: redactLegacyServerPasswordProvider(settings.providers.opencode),
    },
    providerInstances,
  };
}

function normalizeSettings(
  settingsPath: string,
  current: ServerSettings,
  patch: ServerSettingsPatch,
): Effect.Effect<ServerSettings, ServerSettingsError> {
  const preservedPatch = preserveRedactedProviderInstanceEnvironment(
    current,
    preserveRedactedLegacyServerPasswords(current, patch),
  );
  return Schema.decodeUnknownEffect(ServerSettings)(
    applyServerSettingsPatch(current, preservedPatch),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
          cause,
        }),
    ),
  );
}

function decodeSettingsFromJson(settingsPath: string, raw: string) {
  try {
    const decoded = Schema.decodeUnknownExit(ServerSettings)(JSON.parse(raw) as unknown);
    if (decoded._tag === "Failure") {
      return { _tag: "Failure" as const, error: Cause.pretty(decoded.cause) };
    }
    return { _tag: "Success" as const, value: decoded.value };
  } catch (cause) {
    const error = new ServerSettingsError({
      settingsPath,
      detail: "failed to parse settings JSON",
      cause,
    });
    return { _tag: "Failure" as const, error: error.message };
  }
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const settingsRef = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const persistedSecretReferencesRef = yield* Ref.make<PersistedSecretReferences>(new Map());
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };

      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) {
          continue;
        }
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || variable.valueRedacted !== true) {
            environment.push(variable);
            continue;
          }
          const secretReference =
            variable.valueSecretRef ??
            providerEnvironmentSecretName({ instanceId, name: variable.name });
          const secret = yield* secretStore.get(secretReference).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  detail: `failed to read secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                  cause,
                }),
            ),
          );
          const {
            valueRedacted: _valueRedacted,
            valueSecretRef: _valueSecretRef,
            ...materialized
          } = variable;
          environment.push({
            ...materialized,
            value: secret ? textDecoder.decode(secret) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        };
      }

      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeProviderConfigSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };

      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!isRecord(instance.config)) {
          continue;
        }
        let didMaterialize = false;
        const config: Record<string, unknown> = { ...instance.config };
        for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
          const markerKey = `${key}Redacted`;
          if (config[markerKey] !== true) {
            continue;
          }
          const referenceKey = providerConfigSecretReferenceKey(key);
          const configuredReference = config[referenceKey];
          const secretReference =
            typeof configuredReference === "string" && configuredReference.length > 0
              ? configuredReference
              : providerConfigSecretName({ instanceId, key });
          const secret = yield* secretStore.get(secretReference).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  detail: `failed to read secret for provider instance '${instanceId}' config '${key}'`,
                  cause,
                }),
            ),
          );
          config[key] = secret ? textDecoder.decode(secret) : "";
          delete config[markerKey];
          delete config[referenceKey];
          didMaterialize = true;
        }
        if (didMaterialize) {
          providerInstances[instanceId] = {
            ...instance,
            config,
          };
        }
      }

      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeLegacyProviderConfigSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      let providers = settings.providers;

      for (const provider of LEGACY_SERVER_PASSWORD_PROVIDERS) {
        const providerSettings = providers[provider];
        if (providerSettings.serverPasswordRedacted !== true) {
          continue;
        }
        const secretReference =
          providerSettings.serverPasswordSecretRef ??
          legacyProviderConfigSecretName({ provider, key: "serverPassword" });
        const secret = yield* secretStore.get(secretReference).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                detail: `failed to read secret for legacy provider '${provider}' config 'serverPassword'`,
                cause,
              }),
          ),
        );
        const {
          serverPasswordRedacted: _serverPasswordRedacted,
          serverPasswordSecretRef: _serverPasswordSecretRef,
          ...materialized
        } = providerSettings;
        providers = {
          ...providers,
          [provider]: {
            ...materialized,
            serverPassword: secret ? textDecoder.decode(secret) : "",
          },
        };
      }

      return providers === settings.providers ? settings : { ...settings, providers };
    });

  const materializeProviderSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    materializeLegacyProviderConfigSecrets(settings).pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.flatMap(materializeProviderConfigSecrets),
    );

  // Obsolete-secret removals that failed (e.g. transient secret-store errors)
  // would never be re-enqueued by later persists — the old instance/variable
  // is gone from settings by then — so failed names are kept here and retried
  // on every subsequent cleanup until removal succeeds.
  const pendingObsoleteSecretNames = new Set<string>();

  // New values use generation-versioned references, so staging them before the
  // settings rename never overwrites a secret still named by the old file.
  // Superseded references are cleaned up only after commit and in-memory apply.
  const persistProviderSecrets = (
    current: ServerSettings,
    next: ServerSettings,
    currentSecretReferences: PersistedSecretReferences,
  ): Effect.Effect<
    {
      readonly settings: ServerSettings;
      readonly secretReferences: PersistedSecretReferences;
      readonly liveSecretNames: ReadonlySet<string>;
      readonly stagedSecretNames: ReadonlySet<string>;
      readonly obsoleteSecretNames: ReadonlySet<string>;
    },
    ServerSettingsError
  > =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      let providers = next.providers;
      const liveSecretNames = new Set<string>();
      const nextSecretReferences = new Map<string, string>();
      const currentPhysicalSecretNames = new Set(currentSecretReferences.values());
      const stagedSecretNames = new Set<string>();
      const obsoleteSecretNames = new Set(currentSecretReferences.values());

      for (const provider of LEGACY_SERVER_PASSWORD_PROVIDERS) {
        const logicalName = legacyProviderConfigSecretName({
          provider,
          key: "serverPassword",
        });
        obsoleteSecretNames.add(logicalName);
        const value = next.providers[provider].serverPassword;
        if (value.length === 0) {
          const {
            serverPasswordRedacted: _serverPasswordRedacted,
            serverPasswordSecretRef: _serverPasswordSecretRef,
            ...withoutSecretMetadata
          } = providers[provider];
          providers = {
            ...providers,
            [provider]: {
              ...withoutSecretMetadata,
              serverPassword: "",
            },
          };
          continue;
        }

        const currentReference = currentSecretReferences.get(logicalName);
        const secretReference =
          currentReference &&
          currentReference !== logicalName &&
          current.providers[provider].serverPassword === value
            ? currentReference
            : newVersionedSecretReference();
        nextSecretReferences.set(logicalName, secretReference);
        liveSecretNames.add(secretReference);
        if (!currentPhysicalSecretNames.has(secretReference)) {
          stagedSecretNames.add(secretReference);
        }
        yield* secretStore.set(secretReference, textEncoder.encode(value)).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                detail: `failed to write secret for legacy provider '${provider}' config 'serverPassword'`,
                cause,
              }),
          ),
        );
        providers = {
          ...providers,
          [provider]: {
            ...providers[provider],
            serverPassword: "",
            serverPasswordRedacted: true,
            serverPasswordSecretRef: secretReference,
          },
        };
      }

      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        const currentInstance = current.providerInstances[instanceId];
        const currentEnvironment = environmentByName(currentInstance?.environment);
        if (instance.environment) {
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            const logicalName = providerEnvironmentSecretName({
              instanceId,
              name: variable.name,
            });
            obsoleteSecretNames.add(logicalName);
            if (!variable.sensitive) {
              environment.push(redactProviderEnvironmentVariable(variable));
              continue;
            }

            const value = variable.value ?? "";
            if (value.length === 0) {
              const {
                valueRedacted: _valueRedacted,
                valueSecretRef: _valueSecretRef,
                ...withoutRedaction
              } = variable;
              environment.push(withoutRedaction);
              continue;
            }

            const currentReference = currentSecretReferences.get(logicalName);
            const currentVariable = currentEnvironment.get(variable.name.trim());
            const secretReference =
              currentReference &&
              currentReference !== logicalName &&
              currentVariable?.value === value
                ? currentReference
                : newVersionedSecretReference();
            nextSecretReferences.set(logicalName, secretReference);
            liveSecretNames.add(secretReference);
            if (!currentPhysicalSecretNames.has(secretReference)) {
              stagedSecretNames.add(secretReference);
            }
            yield* secretStore.set(secretReference, textEncoder.encode(value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to write secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                    cause,
                  }),
              ),
            );
            const { valueSecretRef: _valueSecretRef, ...withoutReference } = variable;
            environment.push({
              ...withoutReference,
              value: "",
              valueRedacted: true,
              valueSecretRef: secretReference,
            });
          }
          providerInstances[instanceId] = {
            ...instance,
            environment,
          };
        }

        if (isRecord(instance.config)) {
          const persistedConfig: Record<string, unknown> = { ...instance.config };
          let didChangeConfig = false;
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            const logicalName = providerConfigSecretName({ instanceId, key });
            const markerKey = `${key}Redacted`;
            const referenceKey = providerConfigSecretReferenceKey(key);
            obsoleteSecretNames.add(logicalName);
            if (markerKey in persistedConfig) {
              delete persistedConfig[markerKey];
              didChangeConfig = true;
            }
            if (referenceKey in persistedConfig) {
              delete persistedConfig[referenceKey];
              didChangeConfig = true;
            }
            const value = instance.config[key];
            if (typeof value !== "string" || value.length === 0) {
              continue;
            }

            const currentReference = currentSecretReferences.get(logicalName);
            const currentConfigValue = isRecord(currentInstance?.config)
              ? currentInstance.config[key]
              : undefined;
            const secretReference =
              currentReference && currentReference !== logicalName && currentConfigValue === value
                ? currentReference
                : newVersionedSecretReference();
            nextSecretReferences.set(logicalName, secretReference);
            liveSecretNames.add(secretReference);
            if (!currentPhysicalSecretNames.has(secretReference)) {
              stagedSecretNames.add(secretReference);
            }
            yield* secretStore.set(secretReference, textEncoder.encode(value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to write secret for provider instance '${instanceId}' config '${key}'`,
                    cause,
                  }),
              ),
            );
            persistedConfig[key] = "";
            persistedConfig[markerKey] = true;
            persistedConfig[referenceKey] = secretReference;
            didChangeConfig = true;
          }
          const existingInstance = providerInstances[instanceId];
          if (didChangeConfig && existingInstance) {
            providerInstances[instanceId] = {
              ...existingInstance,
              config: persistedConfig,
            };
          }
        }
      }

      // Current-generation cleanup never includes a live reference. Pending
      // retries are retired separately, only after the settings file commits.
      for (const name of liveSecretNames) {
        obsoleteSecretNames.delete(name);
      }

      return {
        settings: {
          ...next,
          providers,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        },
        secretReferences: nextSecretReferences,
        liveSecretNames,
        stagedSecretNames,
        obsoleteSecretNames,
      };
    });

  // Obsolete-secret removal is post-write cleanup: by the time it runs, the
  // new settings are already durable and applied, so it must never fail the
  // settings operation that already landed. Failed removals are remembered in
  // pendingObsoleteSecretNames and retried on every later cleanup — later
  // persists cannot re-enqueue them because the old instance/variable is no
  // longer part of the settings.
  const runObsoleteSecretCleanup = (
    obsoleteSecretNames: ReadonlySet<string>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const names = new Set([...pendingObsoleteSecretNames, ...obsoleteSecretNames]);
      for (const name of names) {
        const removed = yield* secretStore.remove(name).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("failed to remove obsolete provider instance secret", {
              path: settingsPath,
              secret: name,
              error,
            }).pipe(Effect.as(false)),
          ),
        );
        if (removed) {
          pendingObsoleteSecretNames.delete(name);
        } else {
          pendingObsoleteSecretNames.add(name);
        }
      }
    });

  const hasPlaintextProviderInstanceSecrets = (settings: ServerSettings): boolean => {
    for (const provider of LEGACY_SERVER_PASSWORD_PROVIDERS) {
      const providerSettings = settings.providers[provider];
      if (
        providerSettings.serverPassword.length > 0 &&
        providerSettings.serverPasswordRedacted !== true
      ) {
        return true;
      }
    }
    for (const instance of Object.values(settings.providerInstances)) {
      if (
        instance.environment?.some(
          (variable) =>
            variable.sensitive &&
            variable.valueRedacted !== true &&
            (variable.value ?? "").length > 0,
        )
      ) {
        return true;
      }
      if (isRecord(instance.config)) {
        for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
          const value = instance.config[key];
          if (
            typeof value === "string" &&
            value.length > 0 &&
            instance.config[`${key}Redacted`] !== true
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const loadSettingsFromDisk = Effect.gen(function* () {
    const exists = yield* fs.exists(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to check settings file existence",
            cause,
          }),
      ),
    );
    if (!exists) {
      return {
        settings: DEFAULT_SERVER_SETTINGS,
        secretReferences: new Map<string, string>() as PersistedSecretReferences,
      };
    }

    const raw = yield* fs.readFileString(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to read settings file",
            cause,
          }),
      ),
    );
    const decoded = decodeSettingsFromJson(settingsPath, raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("failed to parse settings.json, using defaults", {
        path: settingsPath,
        error: decoded.error,
      });
      return {
        settings: DEFAULT_SERVER_SETTINGS,
        secretReferences: new Map<string, string>() as PersistedSecretReferences,
      };
    }
    const decodedSecretReferences = collectPersistedSecretReferences(decoded.value);
    if (hasPlaintextProviderInstanceSecrets(decoded.value)) {
      // A previous build (or interrupted migration) left instance secrets in
      // plaintext on disk. Materialize existing redacted secrets first so the
      // migration cannot mistake their empty on-disk markers for cleared
      // values, move the plaintext into the secret store, rewrite the
      // redacted settings file, and only then drop obsolete store entries so
      // a failed write never loses a still-referenced secret.
      const materialized = yield* materializeProviderSecrets(decoded.value);
      const {
        settings: persisted,
        secretReferences,
        liveSecretNames,
        stagedSecretNames,
        obsoleteSecretNames,
      } = yield* persistProviderSecrets(materialized, materialized, decodedSecretReferences);
      yield* writeSettingsAtomically(persisted).pipe(
        Effect.tapError(() => runObsoleteSecretCleanup(stagedSecretNames)),
      );
      for (const name of liveSecretNames) {
        pendingObsoleteSecretNames.delete(name);
      }
      yield* runObsoleteSecretCleanup(obsoleteSecretNames);
      return { settings: materialized, secretReferences };
    }
    return {
      settings: yield* materializeProviderSecrets(decoded.value),
      secretReferences: decodedSecretReferences,
    };
  });

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    return Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(tempPath, `${JSON.stringify(settings, null, 2)}\n`);
      yield* fs.rename(tempPath, settingsPath);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              detail: "failed to prepare settings directory",
              cause,
            }),
        ),
      );
      const { settings, secretReferences } = yield* loadSettingsFromDisk;
      yield* Ref.set(settingsRef, settings);
      yield* Ref.set(persistedSecretReferencesRef, secretReferences);
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: Ref.get(settingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const currentSecretReferences = yield* Ref.get(persistedSecretReferencesRef);
          const next = yield* normalizeSettings(settingsPath, current, patch);
          const {
            settings: persisted,
            secretReferences,
            liveSecretNames,
            stagedSecretNames,
            obsoleteSecretNames,
          } = yield* persistProviderSecrets(current, next, currentSecretReferences);
          yield* writeSettingsAtomically(persisted).pipe(
            Effect.tapError(() => runObsoleteSecretCleanup(stagedSecretNames)),
          );
          yield* Ref.set(settingsRef, next);
          yield* Ref.set(persistedSecretReferencesRef, secretReferences);
          yield* emitChange(next);
          for (const name of liveSecretNames) {
            pendingObsoleteSecretNames.delete(name);
          }
          yield* runObsoleteSecretCleanup(obsoleteSecretNames);
          return resolveTextGenerationProvider(next);
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings).pipe(
  Layer.provide(ServerSecretStoreLive),
);
