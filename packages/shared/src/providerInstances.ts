// FILE: providerInstances.ts
// Purpose: Shared provider-instance resolution from legacy and generic settings.
// Layer: Shared runtime utility
// Exports: provider instance derivation and start-option helpers

import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  ServerSettings,
} from "@synara/contracts";
import { ProviderKind as ProviderKindSchema } from "@synara/contracts";
import { Schema } from "effect";

export const BUILT_IN_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "devin",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<ProviderKind>;

export interface ResolvedProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly config: Record<string, unknown>;
  readonly environment: Readonly<Record<string, string>>;
  readonly raw: ProviderInstanceConfig;
}

export interface UnsupportedProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
  readonly environment: Readonly<Record<string, string>>;
  readonly raw: ProviderInstanceConfig;
}

type MutableProviderInstanceConfigMap = Record<string, ProviderInstanceConfig>;
type MutableProviderStartOptions = Partial<Record<ProviderKind, unknown>>;
const PROVIDER_INSTANCE_ID_MAX_CHARS = 64;
const CODEX_ACCOUNT_INSTANCE_PREFIX = "codex_";

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function materializeProviderInstanceEnvironment(
  raw: ProviderInstanceConfig,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const variable of raw.environment ?? []) {
    if (variable.valueRedacted === true) {
      continue;
    }
    const name = variable.name.trim();
    if (!name) {
      continue;
    }
    if (typeof variable.value !== "string") {
      continue;
    }
    environment[name] = variable.value;
  }
  return environment;
}

function providerEnvironmentOption(environment: Readonly<Record<string, string>>): {
  readonly environment?: Readonly<Record<string, string>>;
} {
  return Object.keys(environment).length > 0 ? { environment } : {};
}

function normalizeBinaryPathOverride(provider: ProviderKind, value: unknown): string {
  const trimmed = trimString(value);
  if (!trimmed) {
    return "";
  }
  switch (provider) {
    case "codex":
      return trimmed === "codex" ? "" : trimmed;
    case "claudeAgent":
      return trimmed === "claude" ? "" : trimmed;
    case "cursor":
      return trimmed === "cursor-agent" ? "" : trimmed;
    case "devin":
      return trimmed === "devin" ? "" : trimmed;
    case "antigravity":
      return trimmed === "agy" ? "" : trimmed;
    case "grok":
      return trimmed === "grok" ? "" : trimmed;
    case "droid":
      return trimmed === "droid" ? "" : trimmed;
    case "opencode":
      return trimmed === "opencode" ? "" : trimmed;
    case "pi":
      return trimmed === "pi" ? "" : trimmed;
  }
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return Schema.is(ProviderKindSchema)(value);
}

export function defaultInstanceIdForProvider(provider: ProviderKind): ProviderInstanceId {
  return provider;
}

export function resolveModelSelectionInstanceId(
  selection: Pick<ModelSelection, "provider" | "instanceId"> | null | undefined,
): ProviderInstanceId {
  return selection?.instanceId ?? selection?.provider ?? "codex";
}

export function resolveProviderStatusInstanceId(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
}): ProviderInstanceId {
  return input.instanceId ?? defaultInstanceIdForProvider(input.provider);
}

function stableSlugHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function slugCodexAccountId(accountId: string): string {
  const slug = accountId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "account";
}

export function codexAccountInstanceId(accountId: string): ProviderInstanceId {
  const normalizedAccountId = accountId.trim();
  const slug = slugCodexAccountId(normalizedAccountId);
  const raw = `${CODEX_ACCOUNT_INSTANCE_PREFIX}${slug}`;
  if (raw.length <= PROVIDER_INSTANCE_ID_MAX_CHARS && slug === normalizedAccountId) {
    return raw;
  }
  const hash = stableSlugHash(normalizedAccountId);
  const availableAccountChars =
    PROVIDER_INSTANCE_ID_MAX_CHARS -
    CODEX_ACCOUNT_INSTANCE_PREFIX.length -
    "_".length -
    hash.length;
  return `${CODEX_ACCOUNT_INSTANCE_PREFIX}${slug.slice(0, availableAccountChars)}_${hash}`;
}

function legacyProviderConfig(
  settings: ServerSettings,
  provider: ProviderKind,
): ProviderInstanceConfig {
  const legacy = settings.providers[provider] as Record<string, unknown>;
  return {
    driver: provider,
    enabled: legacy.enabled !== false,
    config: { ...legacy },
  };
}

function deriveLegacyCodexAccountInstances(settings: ServerSettings): ProviderInstanceConfigMap {
  const codex = settings.providers.codex;
  const instances: MutableProviderInstanceConfigMap = {};
  for (const account of codex.accounts) {
    const accountId = account.id.trim();
    if (!accountId || accountId === "default") {
      continue;
    }
    const instanceId = codexAccountInstanceId(accountId);
    instances[instanceId] = {
      driver: "codex",
      displayName: account.label.trim() || accountId,
      enabled: codex.enabled,
      config: {
        binaryPath: codex.binaryPath,
        homePath: account.homePath.trim() || codex.homePath,
        shadowHomePath: account.shadowHomePath.trim(),
        accountId,
        customModels: codex.customModels,
      },
    };
  }
  return instances as ProviderInstanceConfigMap;
}

export function deriveProviderInstanceConfigMap(
  settings: ServerSettings,
): ProviderInstanceConfigMap {
  const merged: MutableProviderInstanceConfigMap = {};

  for (const provider of BUILT_IN_PROVIDER_KINDS) {
    merged[defaultInstanceIdForProvider(provider)] = legacyProviderConfig(settings, provider);
  }

  Object.assign(merged, deriveLegacyCodexAccountInstances(settings), settings.providerInstances);
  return merged as ProviderInstanceConfigMap;
}

function displayNameForInstance(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  raw: ProviderInstanceConfig,
): string {
  const explicit = raw.displayName?.trim();
  if (explicit) {
    return explicit;
  }
  if (instanceId === driver) {
    switch (driver) {
      case "claudeAgent":
        return "Claude";
      case "opencode":
        return "OpenCode";
      default:
        return driver.charAt(0).toUpperCase() + driver.slice(1);
    }
  }
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function deriveProviderInstances(
  settings: ServerSettings,
): ReadonlyArray<ResolvedProviderInstance> {
  const map = deriveProviderInstanceConfigMap(settings);
  const resolved: ResolvedProviderInstance[] = [];
  for (const [instanceId, raw] of Object.entries(map)) {
    if (!isProviderKind(raw.driver)) {
      continue;
    }
    const config =
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? (raw.config as Record<string, unknown>)
        : {};
    resolved.push({
      instanceId,
      driver: raw.driver,
      displayName: displayNameForInstance(instanceId, raw.driver, raw),
      enabled: raw.enabled !== false && config.enabled !== false,
      isDefault: instanceId === raw.driver,
      config,
      environment: materializeProviderInstanceEnvironment(raw),
      raw,
    });
  }
  return resolved;
}

export function deriveUnsupportedProviderInstances(
  settings: ServerSettings,
): ReadonlyArray<UnsupportedProviderInstance> {
  const map = deriveProviderInstanceConfigMap(settings);
  const unsupported: UnsupportedProviderInstance[] = [];
  for (const [instanceId, raw] of Object.entries(map)) {
    if (isProviderKind(raw.driver)) {
      continue;
    }
    const config =
      raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)
        ? (raw.config as Record<string, unknown>)
        : {};
    unsupported.push({
      instanceId,
      driver: raw.driver,
      displayName: displayNameForInstance(instanceId, raw.driver, raw),
      enabled: raw.enabled !== false && config.enabled !== false,
      config,
      environment: materializeProviderInstanceEnvironment(raw),
      raw,
    });
  }
  return unsupported;
}

export function resolveProviderInstance(
  settings: ServerSettings,
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderKind | undefined;
  },
): ResolvedProviderInstance | null {
  const instances = deriveProviderInstances(settings);
  if (input.instanceId !== undefined) {
    return instances.find((instance) => instance.instanceId === input.instanceId) ?? null;
  }
  const requestedInstanceId = input.provider
    ? defaultInstanceIdForProvider(input.provider)
    : "codex";
  return (
    instances.find((instance) => instance.instanceId === requestedInstanceId) ??
    instances.find((instance) => instance.driver === input.provider && instance.isDefault) ??
    instances.find((instance) => instance.instanceId === "codex") ??
    instances[0]!
  );
}

export function providerStartOptionsFromInstance(
  instance: ResolvedProviderInstance,
): ProviderStartOptions | undefined {
  const config = instance.config;
  const binaryPath = normalizeBinaryPathOverride(instance.driver, config.binaryPath);
  const environment = providerEnvironmentOption(instance.environment);
  switch (instance.driver) {
    case "codex": {
      const homePath = trimString(config.homePath);
      const shadowHomePath = trimString(config.shadowHomePath);
      const accountId = trimString(config.accountId);
      return binaryPath || homePath || shadowHomePath || accountId || environment.environment
        ? {
            codex: {
              ...environment,
              ...(binaryPath ? { binaryPath } : {}),
              ...(homePath ? { homePath } : {}),
              ...(shadowHomePath ? { shadowHomePath } : {}),
              ...(accountId ? { accountId } : {}),
            },
          }
        : undefined;
    }
    case "claudeAgent": {
      const homePath = trimString(config.homePath);
      return binaryPath || homePath || environment.environment
        ? {
            claudeAgent: {
              ...environment,
              ...(binaryPath ? { binaryPath } : {}),
              ...(homePath ? { homePath } : {}),
            },
          }
        : undefined;
    }
    case "cursor": {
      const apiEndpoint = trimString(config.apiEndpoint);
      return binaryPath || apiEndpoint || environment.environment
        ? {
            cursor: {
              ...environment,
              ...(binaryPath ? { binaryPath } : {}),
              ...(apiEndpoint ? { apiEndpoint } : {}),
            },
          }
        : undefined;
    }
    case "devin":
      return binaryPath || environment.environment
        ? { devin: { ...environment, ...(binaryPath ? { binaryPath } : {}) } }
        : undefined;
    case "antigravity":
      return binaryPath || environment.environment
        ? { antigravity: { ...environment, ...(binaryPath ? { binaryPath } : {}) } }
        : undefined;
    case "grok":
      return binaryPath || environment.environment
        ? { grok: { ...environment, ...(binaryPath ? { binaryPath } : {}) } }
        : undefined;
    case "droid":
      return binaryPath || environment.environment
        ? { droid: { ...environment, ...(binaryPath ? { binaryPath } : {}) } }
        : undefined;
    case "opencode": {
      const serverUrl = trimString(config.serverUrl);
      const serverPassword = trimString(config.serverPassword);
      const experimentalWebSockets = config.experimentalWebSockets === true;
      return binaryPath ||
        serverUrl ||
        serverPassword ||
        experimentalWebSockets ||
        environment.environment
        ? {
            opencode: {
              ...environment,
              ...(binaryPath ? { binaryPath } : {}),
              ...(serverUrl ? { serverUrl } : {}),
              ...(serverPassword ? { serverPassword } : {}),
              ...(experimentalWebSockets ? { experimentalWebSockets } : {}),
            },
          }
        : undefined;
    }
    case "pi": {
      const agentDir = trimString(config.agentDir);
      return binaryPath || agentDir || environment.environment
        ? {
            pi: {
              ...environment,
              ...(binaryPath ? { binaryPath } : {}),
              ...(agentDir ? { agentDir } : {}),
            },
          }
        : undefined;
    }
  }
}

export function mergeProviderStartOptions(
  base: ProviderStartOptions | undefined,
  overlay: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  if (!base) return overlay;
  if (!overlay) return base;
  const merged: MutableProviderStartOptions = {};
  for (const provider of BUILT_IN_PROVIDER_KINDS) {
    const baseProviderOptions = base[provider];
    const overlayProviderOptions = overlay[provider];
    if (!baseProviderOptions && !overlayProviderOptions) {
      continue;
    }
    merged[provider] = {
      ...baseProviderOptions,
      ...overlayProviderOptions,
    };
  }
  return merged as ProviderStartOptions;
}
