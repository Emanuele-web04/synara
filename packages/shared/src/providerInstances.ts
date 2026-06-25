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
} from "@t3tools/contracts";
import { ProviderKind as ProviderKindSchema } from "@t3tools/contracts";
import { Schema } from "effect";

export const BUILT_IN_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
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
  readonly raw: ProviderInstanceConfig;
}

type MutableProviderInstanceConfigMap = Record<string, ProviderInstanceConfig>;
type MutableProviderStartOptions = Partial<Record<ProviderKind, unknown>>;

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    case "gemini":
      return trimmed === "gemini" ? "" : trimmed;
    case "grok":
      return trimmed === "grok" ? "" : trimmed;
    case "kilo":
      return trimmed === "kilo" ? "" : trimmed;
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

function codexAccountInstanceId(accountId: string): ProviderInstanceId {
  return `codex_${accountId}`;
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
  driver: ProviderKind,
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
      raw,
    });
  }
  return resolved;
}

export function resolveProviderInstance(
  settings: ServerSettings,
  input: {
    readonly instanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderKind | undefined;
  },
): ResolvedProviderInstance {
  const instances = deriveProviderInstances(settings);
  const requestedInstanceId =
    input.instanceId ?? (input.provider ? defaultInstanceIdForProvider(input.provider) : "codex");
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
  switch (instance.driver) {
    case "codex": {
      const homePath = trimString(config.homePath);
      const shadowHomePath = trimString(config.shadowHomePath);
      const accountId = trimString(config.accountId);
      return binaryPath || homePath || shadowHomePath || accountId
        ? {
            codex: {
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
      return binaryPath || homePath
        ? {
            claudeAgent: {
              ...(binaryPath ? { binaryPath } : {}),
              ...(homePath ? { homePath } : {}),
            },
          }
        : undefined;
    }
    case "cursor": {
      const apiEndpoint = trimString(config.apiEndpoint);
      return binaryPath || apiEndpoint
        ? {
            cursor: {
              ...(binaryPath ? { binaryPath } : {}),
              ...(apiEndpoint ? { apiEndpoint } : {}),
            },
          }
        : undefined;
    }
    case "gemini":
      return binaryPath ? { gemini: { binaryPath } } : undefined;
    case "grok":
      return binaryPath ? { grok: { binaryPath } } : undefined;
    case "kilo": {
      const serverUrl = trimString(config.serverUrl);
      const serverPassword = trimString(config.serverPassword);
      return binaryPath || serverUrl || serverPassword
        ? {
            kilo: {
              ...(binaryPath ? { binaryPath } : {}),
              ...(serverUrl ? { serverUrl } : {}),
              ...(serverPassword ? { serverPassword } : {}),
            },
          }
        : undefined;
    }
    case "opencode": {
      const serverUrl = trimString(config.serverUrl);
      const serverPassword = trimString(config.serverPassword);
      const experimentalWebSockets = config.experimentalWebSockets === true;
      return binaryPath || serverUrl || serverPassword || experimentalWebSockets
        ? {
            opencode: {
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
      return binaryPath || agentDir
        ? { pi: { ...(binaryPath ? { binaryPath } : {}), ...(agentDir ? { agentDir } : {}) } }
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
      ...(baseProviderOptions ?? {}),
      ...(overlayProviderOptions ?? {}),
    };
  }
  return merged as ProviderStartOptions;
}
