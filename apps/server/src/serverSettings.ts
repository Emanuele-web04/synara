/**
 * ServerSettings - Server-authoritative settings persistence.
 *
 * Owns settings that affect server-side behavior. The web app can continue to
 * keep UI-only preferences in local storage while these values become durable
 * and process-authoritative on the server.
 */
import {
  DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  type ServerSettingsView,
} from "@synara/contracts";
import type { DeepPartial } from "@synara/shared/Struct";
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
import { writeFileStringAtomically } from "./atomicWrite";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore";
import { ServerConfig } from "./config";
import {
  GIT_TEXT_GENERATION_PROVIDER_ORDER,
  hasDedicatedTextGenerationProvider,
} from "./git/textGenerationSelection";
import {
  ProviderCredentials,
  ProviderCredentialsLive,
  type ExternalProviderServer,
} from "./providerCredentials";

export interface ServerSettingsShape {
  readonly start: Effect.Effect<void, ServerSettingsError>;
  readonly ready: Effect.Effect<void, ServerSettingsError>;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly getSettingsView: Effect.Effect<ServerSettingsView, ServerSettingsError>;
  readonly getSnapshot: Effect.Effect<ServerSettingsSnapshot, ServerSettingsError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettingsView: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettingsView, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerSettings>;
  readonly streamViews: Stream.Stream<ServerSettingsView>;
}

export interface ServerSettingsSnapshot {
  readonly revision: number;
  readonly migrationVersion: number;
  readonly settings: ServerSettings;
}

const SERVER_SETTINGS_MIGRATION_VERSION = 2;
const PREVIOUS_GIT_TEXT_GENERATION_MODEL = "gpt-5.4-mini";
const providerEnvironmentTextEncoder = new TextEncoder();
const providerEnvironmentTextDecoder = new TextDecoder();

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

function providerConfigSecretName(input: { readonly instanceId: string; readonly key: string }) {
  return `provider-config-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.key, "utf8").toString("base64url")}`;
}

function migrateSettings(settings: ServerSettings, migrationVersion: number): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (
    migrationVersion >= 2 ||
    selection.provider !== "codex" ||
    selection.model !== PREVIOUS_GIT_TEXT_GENERATION_MODEL
  ) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      ...selection,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    },
  };
}

export function toServerSettingsView(settings: ServerSettings): ServerSettingsView {
  return redactServerSettingsForClient(settings);
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
        const revisionRef = yield* Ref.make(0);
        const emitChange = (settings: ServerSettings) =>
          PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);
        const getSettings = Ref.get(currentSettingsRef).pipe(
          Effect.map(resolveTextGenerationProvider),
        );
        const updateSettings = (patch: ServerSettingsPatch) =>
          Ref.get(currentSettingsRef).pipe(
            Effect.flatMap((currentSettings) =>
              normalizeSettings("<memory>", currentSettings, patch),
            ),
            Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            Effect.tap(() => Ref.update(revisionRef, (revision) => revision + 1)),
            Effect.tap(emitChange),
            Effect.map(resolveTextGenerationProvider),
          );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings,
          getSettingsView: getSettings.pipe(Effect.map(toServerSettingsView)),
          getSnapshot: Effect.all({
            revision: Ref.get(revisionRef),
            settings: getSettings,
          }).pipe(
            Effect.map(({ revision, settings }) => ({
              revision,
              migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
              settings,
            })),
          ),
          updateSettings,
          updateSettingsView: (patch) =>
            updateSettings(patch).pipe(Effect.map(toServerSettingsView)),
          get streamChanges() {
            return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
          },
          get streamViews() {
            return Stream.fromPubSub(changesPubSub).pipe(
              Stream.map(resolveTextGenerationProvider),
              Stream.map(toServerSettingsView),
            );
          },
        } satisfies ServerSettingsShape;
      }),
    );
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  const selectedInstance = findTextGenerationSelectionInstance(settings, selection);
  if (
    selectedInstance?.enabled &&
    hasDedicatedTextGenerationProvider(selectedInstance.driver)
  ) {
    return selectedInstance.driver === selection.provider &&
      selectedInstance.instanceId === selection.instanceId
      ? settings
      : {
          ...settings,
          textGenerationModelSelection: {
            provider: selectedInstance.driver,
            instanceId: selectedInstance.instanceId,
            model: selection.model,
          } as ModelSelection,
        };
  }

  const fallback = findFallbackTextGenerationInstance(settings);
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      provider: fallback.driver,
      instanceId: fallback.instanceId,
      model:
        fallback.driver === "droid"
          ? DEFAULT_DROID_GIT_TEXT_GENERATION_MODEL
          : DEFAULT_MODEL_BY_PROVIDER[fallback.driver],
    } as ModelSelection,
  };
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

function findFallbackTextGenerationInstance(
  settings: ServerSettings,
): ResolvedProviderInstance | null {
  const instances = deriveProviderInstances(settings);
  for (const provider of GIT_TEXT_GENERATION_PROVIDER_ORDER) {
    const instance = instances.find(
      (candidate) => candidate.enabled && candidate.driver === provider,
    );
    if (instance) {
      return instance;
    }
  }
  return null;
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

function preserveRedactedProviderInstanceConfig(
  currentConfig: unknown,
  nextConfig: unknown,
): unknown {
  if (!isRecord(currentConfig) || !isRecord(nextConfig)) {
    return nextConfig;
  }

  let didRestore = false;
  const restored: Record<string, unknown> = { ...nextConfig };
  for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
    const markerKey = `${key}Redacted`;
    if (nextConfig[markerKey] !== true) {
      continue;
    }
    const currentValue = currentConfig[key];
    if (typeof currentValue !== "string" || currentValue.length === 0) {
      continue;
    }
    restored[key] = currentValue;
    delete restored[markerKey];
    didRestore = true;
  }

  return didRestore ? restored : nextConfig;
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
      if (entry.valueRedacted !== true) {
        return entry;
      }
      const currentEntry = currentEnvironment.get(entry.name.trim());
      if (
        !currentEntry ||
        typeof currentEntry.value !== "string" ||
        currentEntry.value.length === 0
      ) {
        return entry;
      }
      const { valueRedacted: _valueRedacted, ...unredactedEntry } = entry;
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

function redactProviderInstanceConfig(config: unknown): unknown {
  if (!isRecord(config)) {
    return config;
  }

  let didRedact = false;
  const redacted: Record<string, unknown> = { ...config };
  for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
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
  if (!variable.sensitive) {
    const { valueRedacted: _valueRedacted, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...((variable.value ?? "").length > 0 || variable.valueRedacted === true
      ? { valueRedacted: true }
      : {}),
  };
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
  return { ...settings, providerInstances };
}

function normalizeSettings(
  settingsPath: string,
  current: ServerSettings,
  patch: ServerSettingsPatch,
): Effect.Effect<ServerSettings, ServerSettingsError> {
  const preservedPatch = preserveRedactedProviderInstanceEnvironment(current, patch);
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

const EXTERNAL_SERVER_PROVIDERS = ["opencode"] as const;

function readLegacyProviderPasswords(raw: string): ReadonlyMap<ExternalProviderServer, string> {
  try {
    const parsed = JSON.parse(raw) as {
      providers?: Partial<Record<ExternalProviderServer, { readonly serverPassword?: unknown }>>;
    };
    const passwords = new Map<ExternalProviderServer, string>();
    for (const provider of EXTERNAL_SERVER_PROVIDERS) {
      const value = parsed.providers?.[provider]?.serverPassword;
      if (typeof value === "string" && value.trim().length > 0) {
        passwords.set(provider, value.trim());
      }
    }
    return passwords;
  } catch {
    return new Map();
  }
}

function omitProviderPasswords(patch: ServerSettingsPatch): ServerSettingsPatch {
  if (!patch.providers) return patch;
  const { serverPassword: _openCodePassword, ...opencode } = patch.providers.opencode ?? {};
  return {
    ...patch,
    providers: {
      ...patch.providers,
      ...(patch.providers.opencode ? { opencode } : {}),
    },
  };
}

// Migrate only portable Kilo state. Its model/options shape and enabled flag
// remain meaningful, but Kilo binary paths, endpoints, and credentials are not
// compatible with the OpenCode process protocol and must not be copied.
function migrateRemovedKiloSettings(settings: unknown): unknown {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const record = settings as Record<string, unknown>;
  let migrated = record;
  const selection = record.textGenerationModelSelection;
  if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
    const selectionRecord = selection as Record<string, unknown>;
    if (selectionRecord.provider === "kilo") {
      const options = selectionRecord.options;
      const migratedOptions =
        options !== null &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        "kilo" in options
          ? (options as Record<string, unknown>).kilo
          : options;
      migrated = {
        ...migrated,
        textGenerationModelSelection: {
          ...selectionRecord,
          provider: "opencode",
          ...(selectionRecord.instanceId === "kilo" ? { instanceId: "opencode" } : {}),
          ...(migratedOptions === undefined ? {} : { options: migratedOptions }),
        },
      };
    }
  }

  const providers = record.providers;
  if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
    const providerRecord = providers as Record<string, unknown>;
    const kilo = providerRecord.kilo;
    if (kilo !== null && typeof kilo === "object" && !Array.isArray(kilo)) {
      const kiloRecord = kilo as Record<string, unknown>;
      const existingOpenCode =
        providerRecord.opencode !== null &&
        typeof providerRecord.opencode === "object" &&
        !Array.isArray(providerRecord.opencode)
          ? (providerRecord.opencode as Record<string, unknown>)
          : {};
      const portableCustomModels = [
        ...(Array.isArray(existingOpenCode.customModels) ? existingOpenCode.customModels : []),
        ...(Array.isArray(kiloRecord.customModels) ? kiloRecord.customModels : []),
      ].filter(
        (value, index, values) => typeof value === "string" && values.indexOf(value) === index,
      );
      const { kilo: _removedKilo, ...remainingProviders } = providerRecord;
      migrated = {
        ...migrated,
        providers: {
          ...remainingProviders,
          opencode: {
            ...existingOpenCode,
            ...(kiloRecord.enabled === true ? { enabled: true } : {}),
            ...(portableCustomModels.length > 0 ? { customModels: portableCustomModels } : {}),
          },
        },
      };
    }
  }
  return migrated;
}

function decodeSettingsFromJson(settingsPath: string, raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope =
      parsed !== null && typeof parsed === "object" && "settings" in parsed
        ? (parsed as { revision?: unknown; migrationVersion?: unknown; settings: unknown })
        : null;
    const decoded = Schema.decodeUnknownExit(ServerSettings)(
      migrateRemovedKiloSettings(envelope?.settings ?? parsed),
    );
    if (decoded._tag === "Failure") {
      return { _tag: "Failure" as const, error: Cause.pretty(decoded.cause) };
    }
    return {
      _tag: "Success" as const,
      value: decoded.value,
      revision:
        envelope && Number.isSafeInteger(envelope.revision) && Number(envelope.revision) >= 0
          ? Number(envelope.revision)
          : 0,
      migrationVersion:
        envelope && Number.isSafeInteger(envelope.migrationVersion)
          ? Number(envelope.migrationVersion)
          : 0,
      legacyFormat: envelope === null,
    };
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
  const providerCredentials = yield* ProviderCredentials;
  const secretStore = yield* ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const settingsRef = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const revisionRef = yield* Ref.make(0);
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const secretStoreError = (detail: string, cause: unknown) =>
    new ServerSettingsError({ settingsPath, detail, cause });

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        let materializedInstance = instance;
        if (instance.environment) {
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            if (!variable.sensitive || variable.valueRedacted !== true) {
              environment.push(variable);
              continue;
            }
            const secret = yield* secretStore
              .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
              .pipe(
                Effect.mapError((cause) =>
                  secretStoreError(
                    `failed to read secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                    cause,
                  ),
                ),
              );
            const { valueRedacted: _valueRedacted, ...materialized } = variable;
            environment.push({
              ...materialized,
              value: secret ? providerEnvironmentTextDecoder.decode(secret) : "",
            });
          }
          materializedInstance = { ...materializedInstance, environment };
        }

        if (isRecord(instance.config)) {
          const config: Record<string, unknown> = { ...instance.config };
          let changed = false;
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            if (config[`${key}Redacted`] !== true) continue;
            const secret = yield* secretStore
              .get(providerConfigSecretName({ instanceId, key }))
              .pipe(
                Effect.mapError((cause) =>
                  secretStoreError(
                    `failed to read secret for provider instance '${instanceId}' config '${key}'`,
                    cause,
                  ),
                ),
              );
            config[key] = secret ? providerEnvironmentTextDecoder.decode(secret) : "";
            delete config[`${key}Redacted`];
            changed = true;
          }
          if (changed) materializedInstance = { ...materializedInstance, config };
        }
        providerInstances[instanceId] = materializedInstance;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  // Secret writes must land before the settings file references them (a crash
  // after the file write must still materialize), while removals are returned
  // as a deferred effect the caller runs only after the settings write
  // succeeds — otherwise a failed write leaves a settings file whose redacted
  // markers point at secrets that no longer exist.
  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<
    {
      readonly settings: ServerSettings;
      readonly removeObsoleteSecrets: Effect.Effect<void, ServerSettingsError>;
    },
    ServerSettingsError
  > =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const nextEnvironmentSecretKeys = new Set<string>();
      const nextConfigSecretKeys = new Set<string>();
      const obsoleteSecretRemovals: Array<Effect.Effect<void, ServerSettingsError>> = [];

      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        let persistedInstance = instance;
        if (instance.environment) {
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            const secretName = providerEnvironmentSecretName({
              instanceId,
              name: variable.name,
            });
            if (!variable.sensitive) {
              obsoleteSecretRemovals.push(
                secretStore.remove(secretName).pipe(
                  Effect.mapError((cause) =>
                    secretStoreError(
                      `failed to remove secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                      cause,
                    ),
                  ),
                ),
              );
              environment.push(redactProviderEnvironmentVariable(variable));
              continue;
            }

            nextEnvironmentSecretKeys.add(secretName);
            if (variable.valueRedacted !== true) {
              const value = variable.value ?? "";
              if (value.length > 0) {
                yield* secretStore
                  .set(secretName, providerEnvironmentTextEncoder.encode(value))
                  .pipe(
                    Effect.mapError((cause) =>
                      secretStoreError(
                        `failed to write secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                        cause,
                      ),
                    ),
                  );
                environment.push({ ...variable, value: "", valueRedacted: true });
              } else {
                obsoleteSecretRemovals.push(
                  secretStore.remove(secretName).pipe(
                    Effect.mapError((cause) =>
                      secretStoreError(
                        `failed to remove secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                        cause,
                      ),
                    ),
                  ),
                );
                const { valueRedacted: _valueRedacted, ...withoutRedaction } = variable;
                environment.push(withoutRedaction);
              }
              continue;
            }
            environment.push(redactProviderEnvironmentVariable(variable));
          }
          persistedInstance = { ...persistedInstance, environment };
        }

        if (isRecord(instance.config)) {
          const config: Record<string, unknown> = { ...instance.config };
          let changed = false;
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            const secretName = providerConfigSecretName({ instanceId, key });
            const value = instance.config[key];
            if (typeof value !== "string" || value.length === 0) {
              obsoleteSecretRemovals.push(
                secretStore.remove(secretName).pipe(
                  Effect.mapError((cause) =>
                    secretStoreError(
                      `failed to remove secret for provider instance '${instanceId}' config '${key}'`,
                      cause,
                    ),
                  ),
                ),
              );
              delete config[`${key}Redacted`];
              continue;
            }
            nextConfigSecretKeys.add(secretName);
            yield* secretStore.set(secretName, providerEnvironmentTextEncoder.encode(value)).pipe(
              Effect.mapError((cause) =>
                secretStoreError(
                  `failed to write secret for provider instance '${instanceId}' config '${key}'`,
                  cause,
                ),
              ),
            );
            config[key] = "";
            config[`${key}Redacted`] = true;
            changed = true;
          }
          if (changed) persistedInstance = { ...persistedInstance, config };
        }
        providerInstances[instanceId] = persistedInstance;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!nextEnvironmentSecretKeys.has(secretName)) {
            obsoleteSecretRemovals.push(
              secretStore.remove(secretName).pipe(
                Effect.mapError((cause) =>
                  secretStoreError(
                    `failed to remove stale secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                    cause,
                  ),
                ),
              ),
            );
          }
        }
        if (isRecord(instance.config)) {
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            const secretName = providerConfigSecretName({ instanceId, key });
            if (!nextConfigSecretKeys.has(secretName)) {
              obsoleteSecretRemovals.push(
                secretStore.remove(secretName).pipe(
                  Effect.mapError((cause) =>
                    secretStoreError(
                      `failed to remove stale secret for provider instance '${instanceId}' config '${key}'`,
                      cause,
                    ),
                  ),
                ),
              );
            }
          }
        }
      }

      return {
        settings: {
          ...next,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        },
        removeObsoleteSecrets: Effect.all(obsoleteSecretRemovals, { discard: true }),
      };
    });

  const withCredentialState = (settings: ServerSettings) =>
    Effect.all({
      opencode: providerCredentials.isServerPasswordConfigured("opencode"),
    }).pipe(
      Effect.map(
        (configured): ServerSettings => ({
          ...settings,
          providers: {
            ...settings.providers,
            opencode: {
              ...settings.providers.opencode,
              serverPasswordConfigured: configured.opencode,
            },
          },
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to read provider credential state",
            cause,
          }),
      ),
    );

  const hasPlaintextProviderInstanceSecrets = (settings: ServerSettings): boolean => {
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
        settings: yield* withCredentialState(DEFAULT_SERVER_SETTINGS),
        revision: 0,
        migrated: false,
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
      const quarantinePath = `${settingsPath}.invalid-${Date.now()}`;
      yield* fs.rename(settingsPath, quarantinePath).pipe(Effect.catch(() => Effect.void));
      yield* Effect.logWarning("quarantined invalid settings.json, using defaults", {
        path: settingsPath,
        quarantinePath,
        error: decoded.error,
      });
      return {
        settings: yield* withCredentialState(DEFAULT_SERVER_SETTINGS),
        revision: 0,
        migrated: false,
      };
    }
    const hasPlaintextInstanceSecrets = hasPlaintextProviderInstanceSecrets(decoded.value);
    const legacyPasswords = readLegacyProviderPasswords(raw);
    yield* Effect.forEach(
      legacyPasswords,
      ([provider, password]) => providerCredentials.replaceServerPassword(provider, password),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to migrate provider credentials",
            cause,
          }),
      ),
    );
    // Materialize every existing redacted secret before startup persists a
    // plaintext-secret discovery. Otherwise an empty redacted marker could be
    // mistaken for a cleared value and remove the still-referenced secret.
    const materializedSettings = yield* materializeProviderEnvironmentSecrets(
      yield* withCredentialState(migrateSettings(decoded.value, decoded.migrationVersion)),
    );
    return {
      settings: materializedSettings,
      revision: decoded.revision,
      migrated:
        hasPlaintextInstanceSecrets ||
        legacyPasswords.size > 0 ||
        decoded.legacyFormat ||
        decoded.migrationVersion !== SERVER_SETTINGS_MIGRATION_VERSION,
    };
  });

  const writeSettingsAtomically = (snapshot: ServerSettingsSnapshot) => {
    return writeFileStringAtomically({
      filePath: settingsPath,
      contents: `${JSON.stringify(snapshot, null, 2)}\n`,
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
      const loaded = yield* loadSettingsFromDisk;
      if (loaded.migrated) {
        loaded.revision += 1;
        const { settings: persistedSettings, removeObsoleteSecrets } =
          yield* persistProviderEnvironmentSecrets(loaded.settings, loaded.settings);
        yield* writeSettingsAtomically({
          revision: loaded.revision,
          migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
          settings: persistedSettings,
        });
        yield* removeObsoleteSecrets;
      }
      yield* Ref.set(settingsRef, loaded.settings);
      yield* Ref.set(revisionRef, loaded.revision);
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  const getSettings = Ref.get(settingsRef).pipe(Effect.map(resolveTextGenerationProvider));
  const updateSettings = (patch: ServerSettingsPatch) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const disk = yield* loadSettingsFromDisk;
        const current = disk.settings;
        for (const provider of EXTERNAL_SERVER_PROVIDERS) {
          const password = patch.providers?.[provider]?.serverPassword;
          if (password !== undefined) {
            yield* providerCredentials.replaceServerPassword(provider, password).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to update ${provider} server password`,
                    cause,
                  }),
              ),
            );
          }
        }
        const normalized = yield* normalizeSettings(
          settingsPath,
          current,
          omitProviderPasswords(patch),
        );
        const next = yield* withCredentialState(normalized);
        const nextRevision = Math.max(disk.revision, yield* Ref.get(revisionRef)) + 1;
        const { settings: persistedSettings, removeObsoleteSecrets } =
          yield* persistProviderEnvironmentSecrets(current, next);
        yield* writeSettingsAtomically({
          revision: nextRevision,
          migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
          settings: persistedSettings,
        });
        yield* removeObsoleteSecrets;
        yield* Ref.set(settingsRef, next);
        yield* Ref.set(revisionRef, nextRevision);
        yield* emitChange(next);
        return resolveTextGenerationProvider(next);
      }),
    );

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings,
    getSettingsView: getSettings.pipe(Effect.map(toServerSettingsView)),
    getSnapshot: Effect.all({ revision: Ref.get(revisionRef), settings: getSettings }).pipe(
      Effect.map(({ revision, settings }) => ({
        revision,
        migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
        settings,
      })),
    ),
    updateSettings,
    updateSettingsView: (patch) => updateSettings(patch).pipe(Effect.map(toServerSettingsView)),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
    get streamViews() {
      return Stream.fromPubSub(changesPubSub).pipe(
        Stream.map(resolveTextGenerationProvider),
        Stream.map(toServerSettingsView),
      );
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings).pipe(
  Layer.provide(Layer.mergeAll(ProviderCredentialsLive, ServerSecretStoreLive)),
);
