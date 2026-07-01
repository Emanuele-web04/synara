/**
 * ServerSettings - Server-authoritative settings persistence.
 *
 * Owns settings that affect server-side behavior. The web app can continue to
 * keep UI-only preferences in local storage while these values become durable
 * and process-authoritative on the server.
 */
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
} from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import {
  deriveProviderInstances,
  type ResolvedProviderInstance,
  resolveModelSelectionInstanceId,
} from "@t3tools/shared/providerInstances";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
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
>()("t3/serverSettings/ServerSettingsService") {
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

const PROVIDER_ORDER: readonly ProviderWithDefaultModel[] = [
  "codex",
  "claudeAgent",
  "gemini",
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
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to read secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                    cause,
                  }),
              ),
            );
          const { valueRedacted: _valueRedacted, ...materialized } = variable;
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
          const secret = yield* secretStore.get(providerConfigSecretName({ instanceId, key })).pipe(
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

  const materializeProviderSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    materializeProviderEnvironmentSecrets(settings).pipe(
      Effect.flatMap(materializeProviderConfigSecrets),
    );

  const persistProviderSecrets = (
    current: ServerSettings,
    next: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const nextEnvironmentSecretKeys = new Set<string>();
      const nextConfigSecretKeys = new Set<string>();

      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (instance.environment) {
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
            if (!variable.sensitive) {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      detail: `failed to remove secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                      cause,
                    }),
                ),
              );
              environment.push(redactProviderEnvironmentVariable(variable));
              continue;
            }

            nextEnvironmentSecretKeys.add(secretName);
            if (variable.valueRedacted !== true) {
              const value = variable.value ?? "";
              if (value.length > 0) {
                yield* secretStore.set(secretName, textEncoder.encode(value)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath,
                        detail: `failed to write secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                        cause,
                      }),
                  ),
                );
                environment.push({ ...variable, value: "", valueRedacted: true });
              } else {
                yield* secretStore.remove(secretName).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath,
                        detail: `failed to remove secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                        cause,
                      }),
                  ),
                );
                const { valueRedacted: _valueRedacted, ...withoutRedaction } = variable;
                environment.push(withoutRedaction);
              }
              continue;
            }

            environment.push(redactProviderEnvironmentVariable(variable));
          }
          providerInstances[instanceId] = {
            ...instance,
            environment,
          };
        }

        if (isRecord(instance.config)) {
          let persistedConfig: Record<string, unknown> | undefined;
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            const secretName = providerConfigSecretName({ instanceId, key });
            const value = instance.config[key];
            if (typeof value !== "string" || value.length === 0) {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      detail: `failed to remove secret for provider instance '${instanceId}' config '${key}'`,
                      cause,
                    }),
                ),
              );
              continue;
            }

            nextConfigSecretKeys.add(secretName);
            yield* secretStore.set(secretName, textEncoder.encode(value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to write secret for provider instance '${instanceId}' config '${key}'`,
                    cause,
                  }),
              ),
            );
            persistedConfig ??= { ...instance.config };
            persistedConfig[key] = "";
            persistedConfig[`${key}Redacted`] = true;
          }
          const existingInstance = providerInstances[instanceId];
          if (persistedConfig && existingInstance) {
            providerInstances[instanceId] = {
              ...existingInstance,
              config: persistedConfig,
            };
          }
        }
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) {
            continue;
          }
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!nextEnvironmentSecretKeys.has(secretName)) {
            yield* secretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to remove stale secret for provider instance '${instanceId}' environment variable '${variable.name}'`,
                    cause,
                  }),
              ),
            );
          }
        }
        if (isRecord(instance.config)) {
          for (const key of SENSITIVE_PROVIDER_INSTANCE_CONFIG_KEYS) {
            const secretName = providerConfigSecretName({ instanceId, key });
            if (!nextConfigSecretKeys.has(secretName)) {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      detail: `failed to remove stale secret for provider instance '${instanceId}' config '${key}'`,
                      cause,
                    }),
                ),
              );
            }
          }
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

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
      return DEFAULT_SERVER_SETTINGS;
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
      return DEFAULT_SERVER_SETTINGS;
    }
    return yield* materializeProviderSecrets(decoded.value);
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
      const settings = yield* loadSettingsFromDisk;
      yield* Ref.set(settingsRef, settings);
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
          const next = yield* normalizeSettings(settingsPath, current, patch);
          const persisted = yield* persistProviderSecrets(current, next);
          yield* writeSettingsAtomically(persisted);
          yield* Ref.set(settingsRef, next);
          yield* emitChange(next);
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
